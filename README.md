# PHPantom for Orca

PHP and Blade editing in [Orca](https://github.com/stablyai/orca), powered by the
[PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) language server. The plugin gives `.php` and
`.blade.php` files their own editor with diagnostics, completion, hover and go to definition, and it
is aware of Laravel projects.

This is v1 work in progress, so expect rough edges while the editor is still being built out.

## Install

```
orca plugin install noppu-labs/orca-phpantom
```

## Requirements

- The desktop app only. The plugin does not run in the web client.
- Local workspaces only. Files in SSH or remote workspaces are not supported.

## Finding the PHPantom binary

The plugin looks for `phpantom_lsp` in this order and uses the first one it finds:

1. The `phpantomPath` setting, if you set one.
2. Your `PATH`.
3. A copy it downloaded earlier.
4. A fresh download of the pinned release from GitHub, checked against its SHA-256. This only happens when `allowDownload` is on.

## Settings

- `phpantomPath`: full path to `phpantom_lsp`. Leave it empty to use `PATH` or the download.
- `allowDownload`: whether the plugin may download PHPantom when none is installed. On by default.

## Known gaps

To be filled in as v1 is finished.

- In Blade files, PHPantom 1.1.0 shows parameter-name hints that come from its compiled view rather than your code: a `value:` hint after each `{{` and an `args:` hint inside directives such as `@vite(...)` and `@include(...)`.
- Semantic colouring follows PHPantom's default `contextual` mode, which marks only parameters, template parameters, deprecated symbols and static member references. Set `mode = "full"` under `[semantic-tokens]` in `.phpantom.toml` to colour everything.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
