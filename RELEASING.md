# Releasing

Manual process for now (no CI) — proportionate for hand-delivering builds to
a handful of design partners, not a release cadence that justifies the
secrets-management overhead of a CI-driven pipeline yet. Revisit (e.g.
`tauri-action`) once release frequency or partner count grows past what this
comfortably handles.

## Prerequisites (one-time, already done on this machine)

- Updater signing keypair generated via `npx tauri signer generate --ci -p "" -w ~/.tauri/cofounder-updater.key`.
  The private key lives outside the repo at `~/.tauri/cofounder-updater.key` —
  never commit it. The public key is already in `src-tauri/tauri.conf.json`'s
  `plugins.updater.pubkey`.
- `anthonyhudson-hg/cofounder-local` on GitHub is the release host (public
  repo — the updater's plain-JSON mode can't authenticate against a private
  one). The endpoint `.../releases/latest/download/latest.json` always
  resolves to the most recent non-prerelease release's matching asset, so it
  never needs to change between releases.

## Steps

1. **Bump the version** in `src-tauri/tauri.conf.json`'s `version` field and
   root `package.json`'s `version` field (keep them in sync).

   These two are the authoritative version for the release: Tauri takes the
   installer/updater version straight from `tauri.conf.json`. The versions in
   `src-tauri/Cargo.toml` and `sidecar/package.json` are intentionally
   **decoupled** — they are internal crate/package metadata, not surfaced to
   users or the updater, and there is no automated sync check. Leave them or
   bump them for tidiness; either way they do not affect the shipped artifact.

2. **Build, signed**:
   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = "$env:USERPROFILE\.tauri\cofounder-updater.key"
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```
   This runs the full `build:release` pipeline (fetch/verify the portable
   Node binary, clean-reinstall + build + prune `sidecar/`, build the
   frontend) before compiling and packaging.

   **Expect this to take a while** — packaging `sidecar/node_modules`
   (several hundred MB, mostly the vendored Claude/Codex provider CLI
   binaries) into the NSIS installer is the long pole, observed to take
   15+ minutes on a moderately busy dev machine. This is a real cost of the
   "bundle a portable Node + ship node_modules as-is" strategy (see
   CLAUDE.md) — normal, not a hang. Only `nsis` is built (`bundle.targets`
   is scoped to just `["nsis"]`); the MSI/WiX target was dropped because the
   updater plugin only supports NSIS-based updates on Windows and WiX
   packaging of this resource tree was dramatically slower for an artifact
   that would never actually ship.

   If a build fails partway with a linker error (`link.exe failed`) or an
   `EPERM`/file-lock error during `npm ci`, it's very likely leftover file
   handles from a previous interrupted build, not a real regression — close
   any stray `node.exe`/`cmd.exe`/`makensis.exe` processes and retry.

3. **Locate the artifacts** under
   `src-tauri/target/release/bundle/nsis/`:
   - `Cofounder_<version>_x64-setup.exe` — the installer
   - `Cofounder_<version>_x64-setup.exe.sig` — its minisign signature

4. **Author `latest.json`**:
   ```json
   {
     "version": "<version>",
     "notes": "<short changelog>",
     "pub_date": "<UTC ISO-8601 timestamp>",
     "platforms": {
       "windows-x86_64": {
         "signature": "<contents of the .sig file>",
         "url": "https://github.com/anthonyhudson-hg/cofounder-local/releases/download/v<version>/Cofounder_<version>_x64-setup.exe"
       }
     }
   }
   ```

5. **Create the GitHub Release** (tag `v<version>`) on
   `anthonyhudson-hg/cofounder-local`, attach the installer, the `.sig` file,
   and `latest.json` as release assets. **This is the point where anything
   leaves this machine — confirm you actually want to publish before
   proceeding.**

6. **Confirm the endpoint resolves**:
   `https://github.com/anthonyhudson-hg/cofounder-local/releases/latest/download/latest.json`
   should return the file you just uploaded.

## Round-trip verification (do this the first time, and after any updater-related change)

1. Install an *older* build (build+install a previous version, or keep one
   around from before this release).
2. Publish the newer version per the steps above.
3. Launch the older, installed app. Open company settings → "Check for
   updates" (or wait for the automatic on-launch check).
4. Confirm it detects the new version, downloads, installs, and relaunches
   into it — check the app actually reflects the new behavior/version.
5. Launch again and confirm a second check reports no update available.
6. Once: deliberately publish a `latest.json` with a corrupted/mismatched
   `signature` field and confirm the updater refuses to install rather than
   silently accepting it — proves minisign verification is actually being
   enforced, not just configured.

## Before shipping to an actual design partner

Run the app through Windows Sandbox (Windows 11's built-in, free, disposable
clean image — enable via Optional Features if not already on) to confirm it
runs correctly on a machine that's never had Node.js or this app installed.
This wasn't run as part of this feature's development (it requires
interactive/elevated setup), but the repeated "build + strip `node` from
PATH + launch" tests during development are strong evidence the underlying
mechanism works — Sandbox is the final, fully-clean confirmation worth doing
once before a real handoff.
