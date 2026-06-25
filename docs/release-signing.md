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

## 2. Windows — Authenticode signing

CI signs `.msi`/`.exe` with `signtool` using a `.pfx` you supply as a
base64 secret. The step is skipped when `WIN_CERT_BASE64` is unset, so
unsigned dev builds still work.

### Choosing how to sign (and what it costs)

Windows code signing is a spectrum, not a single "buy a cert" step. From
cheapest to most trusted:

| Option | Cost | Clears SmartScreen? | Notes |
| --- | --- | --- | --- |
| **Ship unsigned** | Free | No | Current default. Users click *More info → Run anyway* on first launch. Fine for early/test releases. |
| **Self-signed cert** | Free | No (unless the user trusts your cert) | Proves integrity, not identity. Only useful for internal/enterprise where you can push the cert via GPO. |
| **Azure Trusted Signing** | ~$10/mo | **Yes** | Microsoft's service; certs Windows fully trusts, no hardware token, works in CI. Cheapest *trusted* path. Needs an Azure account + identity verification. |
| **SignPath (OSS program)** | Free for OSS | Yes | Free trusted signing for approved open-source projects. Requires a public repo. |
| **Commercial CA (OV/EV)** | ~$200–400/yr | OV: eventually · EV: immediately | SSL.com, DigiCert, Sectigo. EV usually ships on a hardware token (can't live in CI). |

> **We currently use "Ship unsigned" (Option 1).** No Windows secrets are
> set, so the `Sign Windows installers` step is skipped and the `.msi`/
> `.exe` ship unsigned. See [§2a](#2a-shipping-unsigned-current) for the
> user-facing first-run note. When ready to upgrade, **Azure Trusted
> Signing (~$10/mo)** is the recommended next step — it clears SmartScreen
> without a $200+/yr commitment — or **SignPath** if the repo is public.

### 2a. Shipping unsigned (current)

Nothing to configure — this is the default when `WIN_CERT_BASE64` is
unset. The trade-off is the first-run SmartScreen dialog:

> "Microsoft Defender SmartScreen prevented an unrecognized app from
> starting."

Tell users to click **More info → Run anyway**. This warning softens over
time as the download builds reputation. Document this in your install
instructions so first-run friction doesn't read as "the app is broken."

When you adopt a real cert later (Azure Trusted Signing / SignPath / a
commercial CA), follow §2b to wire up the `.pfx` secrets — no workflow
changes are needed, the signing step activates automatically once
`WIN_CERT_BASE64` is present.

### 2a-alt. Obtain a code-signing certificate (when upgrading)

For a commercial CA, buy from SSL.com, DigiCert, or Sectigo. You'll
receive (or generate and get signed) a `.pfx`/`.p12` containing the cert
+ private key, protected by a password.

> **EV vs OV.** A standard (OV) cert still triggers a SmartScreen
> "unrecognized app" prompt until your signature builds reputation. An
> **EV** cert clears SmartScreen immediately but costs more and usually
> ships on a hardware token (which can't live in CI). For CI-based
> signing, an OV `.pfx` or **Azure Trusted Signing** is the practical
> choice.

### 2b. Load the two Windows secrets

```sh
base64 -i code-signing.pfx | gh secret set WIN_CERT_BASE64 --env release
gh secret set WIN_CERT_PASSWORD --env release    # the .pfx password
```

On Windows/PowerShell, produce the base64 with:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("code-signing.pfx")) `
  | Out-File -NoNewline cert.b64
gh secret set WIN_CERT_BASE64 --env release < cert.b64
```

---

## 3. Verify it worked

1. Run **Actions → Release → Run workflow** (a draft is fine).
2. In the macOS build job logs, look for codesign + notarization steps
   running rather than being skipped. In the Windows job, look for the
   `Sign Windows installers` step actually executing (it's gated on
   `WIN_CERT_BASE64 != ''`).
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
- **Windows:** get a fresh `.pfx` from your CA, redo §2b.
- Updating a secret is the same `gh secret set …` command — it
  overwrites in place.
