# PHPantom for Orca

PHP and Blade editing in [Orca](https://github.com/stablyai/orca), powered by the
[PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) language server. The plugin opens `.php` and
`.blade.php` files in its own editor, which follows Orca's theme, font and save behaviour, and adds:

- errors and warnings as you type
- completion, including adding the `use` line for a class from another namespace
- hover, signature help and inlay hints
- go to definition, also into `vendor/`, and find references
- quick fixes and code actions, formatting, and rename within the file
- PHPantom's colouring and an outline of the file

PHPantom understands Laravel projects, so things like Eloquent model properties complete and
resolve too.

## Install

```
orca plugin install noppu-labs/orca-phpantom
```

Orca shows what the plugin may do and prints an `--approve` flag. Run the command again with that
flag to install it. To try a branch, add it after an `@`, as in
`orca plugin install noppu-labs/orca-phpantom@<branch>`.

## Requirements

- Orca 1.4.259 or newer, desktop app. The plugin does not run in the web client.
- Local workspaces. Files in SSH or other remote workspaces open with highlighting only.
- PHPantom 1.1.0 or newer. You don't have to install it yourself (see below).

## Finding the PHPantom binary

The plugin looks for `phpantom_lsp` in this order and uses the first one it finds:

1. The `phpantomPath` setting, if you set one.
2. Your `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` and `~/.cargo/bin` (on Windows,
   `%USERPROFILE%\.cargo\bin`), in case Orca started without your shell's `PATH`.
3. A copy it downloaded earlier.
4. A fresh download of PHPantom 1.1.0 from its GitHub release, checked against its SHA-256. This
   only happens when `allowDownload` is on.

If you set `phpantomPath` and it doesn't point at a working `phpantom_lsp`, the plugin shows an
error and does not fall back to the other places. A copy on `PATH` older than 1.1.0 is skipped.
The download is kept in `~/Library/Caches/noppu-labs.phpantom` on macOS,
`$XDG_CACHE_HOME/noppu-labs.phpantom` (or `~/.cache/noppu-labs.phpantom`) on Linux, and
`%LOCALAPPDATA%\noppu-labs.phpantom\cache` on Windows.

Hover the PHPantom item in the status bar to see the PHPantom version and where it came from
(`from PATH`, `downloaded` and so on). Click it for the binary's path, the running servers and the
open files.

## Settings

- `phpantomPath`: full path to `phpantom_lsp`. Leave it empty to use `PATH` or the download.
- `allowDownload`: whether the plugin may download PHPantom when none is installed. On by default.

## Colouring

PHPantom colours code in its `contextual` mode by default. That marks parameters, template
parameters, deprecated symbols and static member references, and leaves the rest to the editor's
own highlighting. For full colouring, add this to `.phpantom.toml` at the project root:

```toml
[semantic-tokens]
mode = "full"
```

## Using it with Autocomplete

[Autocomplete](https://github.com/actus7/orca-autocomplete) also opens `.php` files in its own editor
by default, so with both plugins on, only one of them opens a PHP file. We haven't tested it with
Autocomplete itself yet. In our test, a stand-in plugin with the same `.php` editor settings won
over PHPantom for new `.php` and `.blade.php` files. The stand-in was loaded as a development plugin
after PHPantom was installed, so it may have won because it loaded last or because development
plugins come first. Which plugin wins with Autocomplete installed is still to be confirmed. The
details are in [docs/smoke/v1-smoke.md](docs/smoke/v1-smoke.md).

To switch a file to PHPantom, use the view toggle at the top right of the editor tab, beside
Source. It has one icon for each editor that can open the file.

## Known gaps

- Rename works within the open file only. If a rename would also change other files, the plugin
  refuses it and says so. A quick fix that would change other files does nothing when picked and
  shows a note instead.
- Remote workspaces (SSH and other hosts) get highlighting only, with a note in the editor.
- Inlay hints are off in Blade files, because PHPantom 1.1.0 adds stray hints there that come from
  its compiled view rather than your code: `value:` after each `{{`, and `args:` inside directives
  such as `@vite(...)`.
- The outline can come up empty for a very large class. A 1 MB generated file with one class of
  5,820 methods gave PHPantom an outline bigger than Orca accepts in one answer.
- If PHPantom can't tell which file an editor tab holds, the tab gets highlighting only, with a note,
  and tries again after you save.
- A tab that was already open when the plugin loaded may not attach to PHPantom until you open it
  again.
- When a file changes on disk while its workspace is in the background, the editor picks up the
  change only once you switch back to that workspace. We haven't compared this with Orca's Source
  view yet.
- Errors and warnings appear a moment after a file opens, once PHPantom has checked it.
- When you close a tab, PHPantom lets go of that file about a minute later.
- PHPantom indexes the project when it starts, so the first completions in a big project can take a
  moment. The status bar shows `indexing` while it runs.

The last smoke run and a short checklist for the parts that need a person at the keyboard are in
[docs/smoke/v1-smoke.md](docs/smoke/v1-smoke.md).

## Credits

- [PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) does all the PHP and Laravel work.
- Parts of the language server plumbing, the binary lookup and the editor come from
  [Autocomplete](https://github.com/actus7/orca-autocomplete) by actus7 (MIT). See
  `THIRD_PARTY_NOTICES.md`.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
