# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via
[GitHub private vulnerability reporting](https://github.com/noppu-labs/orca-phpantom/security/advisories/new);
please don't open a public issue. Include enough detail to reproduce: the plugin version, your
operating system, and the impact. You can expect an initial response within a week.

## Disclosure policy

The project follows coordinated disclosure. A report stays private while it is assessed and fixed.
Once a fixed version is released, the project publishes the vulnerability as a
[GitHub security advisory](https://github.com/noppu-labs/orca-phpantom/security/advisories)
on this repository, with the affected versions, how to tell whether you are affected, and the
version that fixes it.

## Scope

This repository ships an Orca plugin that runs a worker with your user account and starts
`phpantom_lsp` for PHP and Blade editing. In scope:

- The PHPantom download and its SHA-256 pin (`ASSETS` in `src/services/binary/release.ts`), including
  any way to run a binary that doesn't match the pin.
- Archive extraction, including writes outside the target directory.
- What the worker reads and writes in workspaces.
- The editor frame, and messages that cross it to the worker.
- The release pipeline: tag verification, tarball builds, attestations and checksums.

Bugs in PHPantom itself or in Orca itself are worth reporting upstream as well.

## Verifying releases

Each [GitHub release](https://github.com/noppu-labs/orca-phpantom/releases) ships the plugin
tarball with a GitHub
[build provenance attestation](https://github.com/noppu-labs/orca-phpantom/attestations)
showing CI built it from the tagged commit. The Sigstore bundle (`<tarball>.intoto.jsonl`),
`release-entry.json` and `checksums-sha256.txt` are attached next to it.

```sh
gh attestation verify orca-phpantom-<version>.tar.gz --repo noppu-labs/orca-phpantom
tar -xzf orca-phpantom-<version>.tar.gz && orca plugin inspect orca-phpantom-<version>
# "Content hash:" must equal contentHash in release-entry.json
```
