# Releasing Avva Mobile Sidekick

Packaging and auto-update are described in D036. Configuration: `electron-builder.yml`, CI: `.github/workflows/release.yml`.

## One-time setup

The repository is public; installed apps download updates from its GitHub Releases. Uploads use the workflow's own `GITHUB_TOKEN`.

Optional signing secrets (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Developer ID Application certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12 \| pbcopy`) |
| `MAC_CSC_KEY_PASSWORD` | Password of that `.p12` |
| `APPLE_API_KEY_P8` | Contents of the App Store Connect API key file (`AuthKey_XXXX.p8`) |
| `APPLE_API_KEY_ID` | Key ID of that API key |
| `APPLE_API_ISSUER` | Issuer ID (App Store Connect → Users and Access → Integrations) |
| `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD` | Optional: Windows code-signing certificate (`.pfx`, base64) and password |

Without the macOS secrets the build is unsigned: Gatekeeper blocks it and auto-update does not work on macOS.

## Cutting a release

1. Bump `version` in `package.json` (e.g. `0.2.0`) and commit.
2. Tag and push: `git tag v0.2.0 && git push origin master v0.2.0`.
3. The Release workflow checks the tag against `package.json`, creates a draft release, builds Windows (NSIS `.exe`, `latest.yml`) and — only when the `MAC_CSC_LINK` secret exists — macOS into it, then publishes it.
4. Without that secret (the current setup: the Developer ID stays in the release Mac's keychain), sign and notarize macOS on the release Mac and upload it to the same release:
   ```sh
   APPLE_API_KEY=~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 APPLE_API_KEY_ID=<KEY_ID> APPLE_API_ISSUER=<ISSUER_ID> npm run release:mac
   ```
   It builds arm64 + x64 DMG/zip, signs with the keychain's Developer ID, notarizes, and uploads them with `latest-mac.yml` (replacing any files of the same name).
5. Installed apps pick it up within 4 hours (or via "Check for Updates…").

## Local builds

- `npm run dist:mac` → `dist/` (signed only if a Developer ID is in the keychain; `CSC_IDENTITY_AUTO_DISCOVERY=false` forces unsigned).
- `npm run dist:win` → needs Windows, or macOS with Rosetta (the bundled `makensis` is an Intel binary).
- Builds never publish unless `npm run release` is used with `GH_TOKEN` set.

## Windows notes

- Installs per user into `%LOCALAPPDATA%\Programs`, no admin rights.
- Claude Code must be installed and on `PATH` (`claude.exe` or `claude.cmd`).
- Still to verify on a real Windows machine: title bar buttons, terminal + Claude start, Stop hook with and without Git Bash, notifications.
