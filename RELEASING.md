# Releasing

Releases are built by `.github/workflows/release.yml`. The trigger is
**manual** — there is no auto-build on push or tag. You bump the
version, commit, then click "Run workflow".

## Quick procedure

1. **Bump the version** locally — both files in lockstep:
   ```sh
   yarn bump-version 0.2.0
   git add src-tauri/tauri.conf.json src-tauri/Cargo.toml
   git commit -m "Release v0.2.0"
   git push
   ```
   The bump script refuses to run if the two files disagree before
   the bump.

2. **Go to Actions → Release → Run workflow**. Inputs:
   - `version` — leave blank to read from `tauri.conf.json`.
   - `publish` — `false` (default) ships as a **draft** you can review
     and edit. `true` publishes immediately.
   - `prerelease` — flags the release as a pre-release.

3. **Wait ~15 minutes.** macOS universal is the slowest leg; the
   matrix is `fail-fast: false`, so a single-platform regression
   doesn't kill the rest.

4. **Review the draft release** (Releases → Nembrix v\<version\>).
   Auto-generated notes pull from merged PRs since the previous tag.
   Edit before publishing.

5. **Publish** by clicking the green button in the GitHub UI, or
   re-run the workflow with `publish: true`.

## Required repo secrets

The workflow reads from GitHub repo secrets (`Settings → Secrets and
variables → Actions`). When a secret is missing, the relevant signing
step is **skipped** rather than failing — so you can ship an unsigned
test build before all the certs are in place.

### macOS code signing + notarization

| Secret | What it is | How to get it |
| --- | --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded `.p12` containing your Developer ID Application certificate + private key | Keychain Access → export the cert as `.p12` → `base64 -i cert.p12 \| pbcopy` |
| `APPLE_CERTIFICATE_PASSWORD` | Password set when exporting the `.p12` | You chose it during export |
| `APPLE_SIGNING_IDENTITY` | The exact identity string (e.g. `"Developer ID Application: Your Name (TEAMID)"`) | `security find-identity -v -p codesigning` |
| `APPLE_ID` | Your Apple ID email | The email tied to your Developer account |
| `APPLE_PASSWORD` | An **app-specific** password (NOT your Apple ID password) | [appleid.apple.com](https://appleid.apple.com) → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Your 10-character team ID | [developer.apple.com/account](https://developer.apple.com/account) → Membership |

Without these, the build still produces a `.dmg`, but it's unsigned
and macOS users get a "this app cannot be opened" warning until they
right-click → Open.

### Windows Authenticode signing

| Secret | What it is |
| --- | --- |
| `WIN_CERT_BASE64` | Base64-encoded `.pfx` containing your code-signing cert. `certutil -encode cert.pfx cert.txt` then strip the BEGIN/END lines. |
| `WIN_CERT_PASSWORD` | Password set when exporting / receiving the `.pfx` |

Cert vendors: SSL.com, DigiCert, Sectigo (~$200-400/year). EV
certificates avoid SmartScreen warnings on first run but cost more.

Without these, the `.msi` ships unsigned. Windows SmartScreen shows a
blue "Microsoft Defender SmartScreen prevented an unrecognized app
from starting" dialog on first run.

### Homebrew tap (optional)

| Secret | What it is |
| --- | --- |
| `HOMEBREW_TAP_TOKEN` | PAT with `repo` scope on the tap repo. The release workflow uses this to clone, update the cask file, and push. |
| `HOMEBREW_TAP_REPO` | (optional) Override the default tap repo name. Defaults to `<owner>/homebrew-<repo>`. |

Without `HOMEBREW_TAP_TOKEN` set, the brew step is skipped silently —
the rest of the release ships normally.

**One-time tap setup:**

1. Create a new public repo named `homebrew-db-client` (the
   `homebrew-` prefix is mandatory — Homebrew finds taps by name).
2. Initialize it with an empty `Casks/` directory.
3. Add a basic README. Recommended:
   ```sh
   echo "# Homebrew tap for Nembrix" > README.md
   echo "" >> README.md
   echo "brew install --cask <user>/db-client/db-client" >> README.md
   ```
4. Generate a fine-grained PAT scoped to that single repo with
   contents:write permission. Add it as `HOMEBREW_TAP_TOKEN` here.

After the first release, users install with:

```sh
brew tap <user>/db-client
brew install --cask db-client
```

Or in one line:

```sh
brew install --cask <user>/db-client/db-client
```

The cask template lives at `.cask/db-client.rb.tmpl`. The workflow
substitutes `__VERSION__`, `__SHA256__`, `__OWNER__`, `__REPO__`
at release time and pushes the rendered file to `Casks/db-client.rb`
in the tap repo.

Pre-release builds (`prerelease: true`) **skip** the brew update — we
don't want `brew install` to point at beta dmgs.

### Tauri auto-updater (optional, future)

If you wire up the Tauri updater later:

| Secret | What it is |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Private key for signing update bundles |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the private key |

Generated via `yarn tauri signer generate -- -w ~/.tauri/db-client.key`.

## Platforms

Built in parallel:

- **macOS universal** (`universal-apple-darwin`) — single `.dmg` for
  Intel + Apple Silicon. Slowest leg (~12 min).
- **Windows x64** — `.msi` installer + portable `.exe`.
- **Linux x86_64** — `.AppImage` + `.deb`.
- **Linux arm64** — `.AppImage` cross-compiled.

To add or remove platforms, edit the `build` job's `matrix.include`
in `release.yml`.

## Re-running a failed build

The `prepare` job is idempotent — it reuses the existing draft release
when there's already one for the same tag. So you can re-trigger the
workflow as many times as you need; the matrix jobs just re-upload
their artifacts.

If a single platform fails, click `Re-run failed jobs` on the workflow
run page.

## What gets attached to the release

Every artifact `tauri-action` produces lands on the GitHub Release
automatically. Filenames follow Tauri's defaults:

```
DB-Client_<version>_universal.dmg
DB-Client_<version>_universal.app.tar.gz
DB-Client_<version>_x64_en-US.msi
DB-Client_<version>_x64-setup.exe
DB-Client_<version>_amd64.AppImage
DB-Client_<version>_amd64.deb
DB-Client_<version>_arm64.AppImage
```

## Icons

Source: `src-tauri/icons/source.png` (1024×1024).

Replace with a real icon when you have one, then regenerate the
platform variants:

```sh
yarn tauri icon src-tauri/icons/source.png
```

`gen-placeholder-icon.ts` was used to produce the initial source.
You can delete that script once you replace it.

## Pre-release checklist

- [ ] Both version strings (`tauri.conf.json` + `Cargo.toml`) match
- [ ] `yarn test:unit` is green
- [ ] `yarn build` succeeds locally
- [ ] (optional) `yarn tauri build` succeeds locally on at least one
      platform
- [ ] Smoke-test the artifacts: download one of the dmg/msi/AppImage
      from the draft release and run it before publishing
