# Release signing — step by step

This is the hands-on companion to [`RELEASING.md`](../RELEASING.md). That
doc lists *what* each secret is; this one walks through *producing* the
certificate material and *loading* it into GitHub.

You only do this once per machine / per cert. After the secrets exist,
the release workflow signs automatically on every run.

> **Where the secrets live.** The release jobs are gated behind the
> `release` GitHub Environment. Set signing secrets on that environment
> (`--env release`) so they're only exposed to release runs, not every
> workflow. If you haven't created the environment yet, create it first
> (`Settings → Environments → New environment → release`) or drop
> `--env release` to set them repo-wide.

Secrets never need to pass through anyone else — run every command below
on your own machine.

---

## 1. macOS — Developer ID signing + notarization

### Prerequisites

- An **Apple Developer Program** membership ($99/yr). Without it you
  cannot create a Developer ID Application certificate.
- Xcode command-line tools (`xcode-select --install`).

### 1a. Create the Developer ID Application certificate

If you don't already have one in Keychain:

1. [developer.apple.com/account](https://developer.apple.com/account) →
   **Certificates, IDs & Profiles → Certificates → +**
2. Choose **Developer ID Application**, follow the CSR steps (Keychain
   Access → Certificate Assistant → *Request a Certificate from a
   Certificate Authority*), upload the CSR, download the resulting
   `.cer`, and double-click it to install into your **login** keychain.

### 1b. Find your signing identity

```sh
security find-identity -v -p codesigning
```

Copy the full quoted string, e.g.
`Developer ID Application: Your Name (AB12CD34EF)`. The 10 characters in
parentheses are your **Team ID**.

### 1c. Export the cert + private key as a `.p12`

1. Keychain Access → **login** keychain → **My Certificates**.
2. Find *Developer ID Application: …*, expand it so the **private key**
   is shown nested beneath it, select **both** the cert and the key.
3. Right-click → **Export 2 items…** → format **Personal Information
   Exchange (.p12)** → save as `DeveloperIDApplication.p12`.
4. Set an export password when prompted — **remember it**, it becomes
   `APPLE_CERTIFICATE_PASSWORD`.

### 1d. Create an app-specific password (for notarization)

Your real Apple ID password won't work for notarization.

1. [appleid.apple.com](https://appleid.apple.com) → **Sign-In and
   Security → App-Specific Passwords → +**
2. Label it e.g. "nembrix notarization", copy the generated value. This
   is `APPLE_PASSWORD`.

### 1e. Load the six macOS secrets into GitHub

```sh
# Cert as base64 (CI has no Keychain, so the .p12 is injected directly):
base64 -i DeveloperIDApplication.p12 | gh secret set APPLE_CERTIFICATE --env release
gh secret set APPLE_CERTIFICATE_PASSWORD --env release   # the .p12 export password from 1c

# Identity + account details:
gh secret set APPLE_SIGNING_IDENTITY --env release       # "Developer ID Application: … (TEAMID)" from 1b
gh secret set APPLE_TEAM_ID          --env release       # the 10-char id from 1b
gh secret set APPLE_ID               --env release       # your Apple Developer email
gh secret set APPLE_PASSWORD         --env release       # app-specific password from 1d
```

`gh secret set` reads the value from stdin when you don't pipe it — it
prompts and hides input, so you never echo a secret into your shell
history.

### Local builds vs CI

For local `yarn build:prod`, you do **not** set `APPLE_CERTIFICATE` /
`APPLE_CERTIFICATE_PASSWORD` — the signer reads the cert straight from
your Keychain. You only need the other four in `apps/desktop/.env.signing`
(copy from `.env.signing.example`). CI is the only place that needs the
base64 `.p12`, because runners have no Keychain.

---

## 2. Windows — Authenticode signing (SignPath OSS)

CI signs `.msi`/`.exe` with **SignPath's free OSS program**. SignPath is a
cloud signer: there's no `.pfx` and no cert to manage — the workflow
uploads each installer, SignPath signs it under a signing policy, and the
signed file is downloaded back over the original. Signatures are
timestamped server-side, so already-shipped installers stay valid after
the underlying cert rotates.

**Skips cleanly when unconfigured.** `SIGNPATH_API_TOKEN` is exposed once
at the build-job level, and every SignPath step is gated on
`env.SIGNPATH_API_TOKEN != ''`. Until you set the token, all four signing
steps (stage → upload → sign → restore) are skipped and the build ships
unsigned installers — the rest of the release still succeeds. No workflow
edit is needed to turn signing on; setting the token (plus the
`SIGNPATH_*` variables) activates it.

> **Why SignPath here.** Azure Trusted/Artifact Signing — the other cheap
> trusted option — is geo-restricted: individuals only in the USA/Canada,
> organizations only in USA/Canada/EU/UK. SignPath's OSS program has no
> such restriction and is free for approved public repos, so it's the fit
> for this project. (If you later have a US/EU/UK entity, Azure is a valid
> alternative; see this file's git history for the Azure variant.)

### Choosing how to sign (and what it costs)

Windows code signing is a spectrum, not a single "buy a cert" step. From
cheapest to most trusted:

| Option | Cost | Clears SmartScreen? | Notes |
| --- | --- | --- | --- |
| **Ship unsigned** | Free | No | Users click *More info → Run anyway* on first launch. Fine for early/test releases. |
| **Self-signed cert** | Free | No (unless the user trusts your cert) | Proves integrity, not identity. Only useful for internal/enterprise where you can push the cert via GPO. |
| **SignPath (OSS program)** | Free for OSS | Yes | Free trusted signing for approved open-source projects. Requires a public repo. **What this workflow uses.** |
| **Azure Artifact Signing** | ~$10/mo | Yes | Microsoft's service, no hardware token, CI-friendly — but geo-restricted (US/CA individuals; US/CA/EU/UK orgs). |
| **Commercial CA (OV/EV)** | ~$200–400/yr | OV: eventually · EV: immediately | SSL.com, DigiCert, Sectigo. EV usually ships on a hardware token (can't live in CI). |

> **The workflow is wired for SignPath.** Until `SIGNPATH_API_TOKEN` is set
> the signing steps are skipped and the `.msi`/`.exe` ship unsigned (see
> [§2a](#2a-shipping-unsigned) for the user-facing first-run note). Setting
> the token + the `SIGNPATH_*` repo variables (§2b–2d) activates signing —
> no workflow changes needed.

### 2a. Shipping unsigned

Until `SIGNPATH_API_TOKEN` exists, installers ship unsigned. The trade-off
is the first-run SmartScreen dialog:

> "Microsoft Defender SmartScreen prevented an unrecognized app from
> starting."

Tell users to click **More info → Run anyway**, and document it in your
install instructions so first-run friction doesn't read as "the app is
broken."

### 2b. Apply to the SignPath OSS program

You do this once. It's free for approved open-source projects and the repo
must be public.

1. **Apply** at [signpath.org](https://signpath.org) (the SignPath
   *Foundation* — the free OSS program, distinct from the commercial
   signpath.io). Submit nembrix's public repo URL.
2. **Wait for approval.** A human reviews the application; this can take a
   few business days, similar to other code-signing identity checks. You
   can't sign until it's approved and your org is provisioned.
3. Once approved you get a SignPath **organization**. Note its
   **Organization ID** (a GUID, in *Settings → Organization*).

### 2c. Set up the project, policy, and API token

Inside your approved SignPath organization:

1. **Create a project** for nembrix. Its slug becomes
   `SIGNPATH_PROJECT_SLUG` (e.g. `nembrix`).
2. **Add an artifact configuration** describing the uploaded zip of
   installers (the OSS onboarding docs/template cover this). Its slug
   becomes `SIGNPATH_ARTIFACT_CONFIG_SLUG`.
3. **Pick/confirm a signing policy.** Use `release-signing` for releases
   (there's also `test-signing`). The slug becomes `SIGNPATH_POLICY_SLUG`.
4. **Create an API token** (*Settings → API Tokens*) scoped to submit
   signing requests. This is the only **secret**; the rest are non-secret
   slugs/ids.

### 2d. Load the SignPath config

The org id / slugs are **not secret** — store them as repo *variables*; only
the token is a *secret*. (Set them on the `release` environment to match
the rest of the signing config.)

```sh
# Non-secret config → repo/environment variables:
gh variable set SIGNPATH_ORGANIZATION_ID      --env release   # GUID from 2b.3
gh variable set SIGNPATH_PROJECT_SLUG         --env release   # project slug from 2c.1
gh variable set SIGNPATH_ARTIFACT_CONFIG_SLUG --env release   # artifact config slug from 2c.2
gh variable set SIGNPATH_POLICY_SLUG          --env release   # e.g. release-signing, from 2c.3

# The one secret → the API token:
gh secret set SIGNPATH_API_TOKEN --env release                # API token from 2c.4
```

`gh secret set` reads from stdin when you don't pipe a value — it prompts
and hides input, so the token never hits your shell history.

---

## 3. Verify it worked

1. Run **Actions → Release → Run workflow** (a draft is fine).
2. In the macOS build job logs, look for codesign + notarization steps
   running rather than being skipped. In the Windows job, look for the
   `Sign Windows installers (SignPath)` step actually executing (it's
   gated on `SIGNPATH_API_TOKEN != ''`).
3. Download the artifacts from the draft release and check signatures:

   ```sh
   # macOS — should report "accepted" / "Notarized Developer ID":
   spctl -a -vvv -t install /Volumes/Nembrix/Nembrix.app
   codesign -dv --verbose=4 /Volumes/Nembrix/Nembrix.app

   # Windows (from PowerShell):
   Get-AuthenticodeSignature .\Nembrix_x64-setup.exe
   ```

If signing was skipped, double-check the secret names match exactly and
that they're on the **`release` environment** (or repo-wide if you set
them there) — a typo'd secret name silently falls through to an unsigned
build.

---

## Rotating / revoking

- **macOS:** revoke the old cert in the Apple Developer portal, create a
  new Developer ID Application cert, redo §1c–1e. Already-shipped builds
  stay valid (they were signed when the cert was live).
- **Windows:** there's no cert to rotate — SignPath manages the cert. To
  rotate *CI credentials*, create a new API token in the SignPath portal,
  revoke the old one, and redo the `SIGNPATH_API_TOKEN` step in §2d.
- Updating a secret is the same `gh secret set …` command — it
  overwrites in place.
