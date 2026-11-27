# Security assessment

This page lists what could go wrong in orca-phpantom, how likely and how costly each problem is, and what the code does about it. It was last reviewed for version 0.2.1. A change to the binary lookup or download, archive extraction, the `phpantom.*` requests, file location or the release pipeline should update it. [ARCHITECTURE.md](ARCHITECTURE.md) describes the actors and interfaces named here.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## What is worth protecting

- The user's machine and account. The worker and every PHPantom it starts run with the user's rights and Orca's environment, so a binary the plugin runs can do anything the user can.
- The user's files, including files outside their workspaces, which the worker can read.
- The text in each tab. A change applied to the wrong text, or an edit from a stale answer, corrupts the file on the next save.
- The plugin itself, because a tampered commit or release would run inside every user's Orca.

## Trust boundaries

- The worker trusts the Orca host: its workspace list, its settings and the panel requests it relays.
- Each editor frame is isolated. Its requests are input the worker checks: a document must be attached under the current session, chunks must arrive in order, and a change must match the expected version and length.
- PHPantom's output is untrusted input. So is the downloaded archive until its SHA-256 matches the pin.
- A `phpantom_lsp` the user installed, on `PATH`, in a well-known folder or named in `phpantomPath`, is trusted as the user's own.
- Project files are the user's data, but PHPantom runs project tools such as `vendor/bin/phpstan` when it finds them.

## Risks

### 1. A tampered PHPantom download

Impact: high. Likelihood: low.

The download URL and the SHA-256 of each platform's archive are pinned in `src/services/binary/release.ts`. The whole archive is hashed before anything reads it, and a mismatch stops the download. The binary is written to a temporary file in the cache folder, made executable and renamed into place, and a `verified` marker is written beside it. Downloading needs `allowDownload`, which the user can turn off.

What remains: a cached copy is trusted on its marker and a working `--version`, and is never hashed again, so anything running as the user can replace it. Installed copies are not pinned at all, and the lookup runs `--version` on every candidate it finds. The download is held in memory with no size limit.

### 2. A hostile archive

Impact: medium. Likelihood: very low, since only an archive that matches the pin is ever parsed.

Extraction (`src/services/binary/extract.ts`) reads one member, `phpantom_lsp` or `phpantom_lsp.exe`, from memory with Node's own zlib, and writes it to a fixed path. No name from the archive becomes a path, so an entry cannot write outside the cache folder. A tar header whose size cannot advance the walk or runs past the buffer throws, and so does a zip entry whose data runs past the central directory or an unsupported compression method. fast-check properties feed it corrupted and cut archives, 1,000 runs per property on each pull request and 10,000 weekly.

What remains: gunzip and inflate have no output limit.

### 3. Malformed LSP output

Impact: medium, since an exception in the stdout handler would end the worker and detach every tab. Likelihood: low.

`src/services/lsp/jsonrpc.ts` drops a body that is not JSON, skips and logs one that is not an object, and discards a header without a length. A notification handler that throws is caught and logged, and every event the router handles runs inside a guard. A notification without params is reported instead of read. `initialize` must answer within 60 seconds. An answer too big for Orca is cut or refused before it leaves the worker. A server that crashes 4 times in 5 minutes is not restarted until the user asks.

What remains: `Content-Length` has no limit, so a frame is buffered in full whatever size it declares. Results and diagnostics reach the frame as PHPantom sent them, checked only where the code branches on a field.

### 4. A workspace file opened outside the workspace root

Impact: medium (a file the user did not open is read). Likelihood: low.

The file search walks only local workspaces, and the walk does not enter symlinked folders. A document attaches only to a file inside a local workspace, and its Composer root stays inside that workspace. `phpantom.navigate` refuses a URI that is not `file:`, that names no existing file, or that lies outside every local workspace, and it asks Orca to open a workspace-relative path.

What remains: `navigate` does not resolve symlinks, so a link inside a workspace can lead to a file outside it. `phpantom.peek` reads any `file:` URI the frame sends, up to 25 files and 600 KiB, with no workspace check, and returns the text to the frame, so script running in a frame can read, through the worker, any file the user can read.

### 5. The bundled Monaco and its DOMPurify advisories

Impact: medium, because script in a frame can send every `phpantom.*` request, `peek` included. Likelihood: low.

PHPantom's hovers and its completion and signature documentation are rendered by Monaco's Markdown renderer, which sanitizes with DOMPurify. The plugin never marks Markdown as trusted, so command links stay off. The bundle holds Monaco 0.58.0 with DOMPurify 3.4.17, and `npm audit` reports no advisory for either. Each frame is isolated (`"frame": "isolated"` in the manifest).

What remains: the editor does not set Monaco's `markdownImages` option, whose default allows images from any origin, so a hover with a remote image makes the frame fetch it. Whether Orca's frame blocks that request has not been checked. A fix in Monaco or DOMPurify reaches users only after `npm run build` and a release. Dependabot raises those bumps as their own group.

### 6. Opening an untrusted project runs its tools

Impact: high. Likelihood: depends on what the user opens.

The plugin starts PHPantom for any PHP file in a local workspace, and PHPantom documents that it runs PHPStan, PHPCS, PHPMD and Mago from the project's `vendor/bin` or `PATH` when it finds them. The plugin passes no command of its own. Remote workspaces get no PHPantom.

What remains: opening a file in a hostile repository runs that repository's tools with the user's rights. The README's static analysis section says which tools run and how to switch each one off in `.phpantom.toml`.

### 7. A tampered plugin release

Impact: high. Likelihood: low.

The plugin has no runtime dependencies. CI installs from the committed lockfile with install scripts off, and every GitHub Action is pinned to a commit. `editor/dist` is generated from `editor/src` by `scripts/build-editor.ts`. Orca installs plugins from the repository and runs no build, so the bundle is committed, and CI rebuilds it on every pull request and fails on any difference. `tests/ship-set.test.ts` fails on any file Orca's indexer would refuse. `release.yml` tags only a commit on `main` whose `orca-plugin.json` and `package.json` versions match, and publishes the `git archive` tarball with a build provenance attestation, `release-entry.json` and checksums. [SECURITY.md](../SECURITY.md#verifying-releases) shows how to verify a release.

What remains: whoever can merge to `main` controls the release, and that is one maintainer today (see [GOVERNANCE.md](GOVERNANCE.md)). The rulesets that `release.yml` expects live in the repository settings, and as the organization's only admin the maintainer can bypass them. An install straight from the repository has no attestation of its own; the check is to compare Orca's content hash with `release-entry.json`.
