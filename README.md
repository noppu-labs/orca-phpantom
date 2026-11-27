# PHP, Laravel, Symfony and WordPress for Orca

This plugin opens PHP files, Blade templates and Drupal's PHP files (`.module`, `.theme` and the
rest) in [Orca](https://github.com/stablyai/orca) with an editor backed by the
[PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) language server. PHPantom understands
Laravel, Symfony, WordPress, Drupal, Yii 3, Tempest, PHPUnit and Pest, and detects each one from
the project, so there is nothing to set up. The editor follows Orca's theme, font and save
behaviour, and adds:

- errors and warnings as you type, and completion that adds the `use` line for a class
- hover, signature help, inlay hints, and go to definition (also into `vendor/`) and references
- quick fixes, code actions, formatting, rename within the file, colouring and an outline

## Install

```
orca plugin install noppu-labs/orca-phpantom
```

Orca shows what the plugin may do and prints an `--approve` flag; run the command again with it.
To try a branch, add it after an `@`, as in `orca plugin install noppu-labs/orca-phpantom@<branch>`.

## Requirements

- Orca 1.4.259 or newer, desktop app. The plugin does not run in the web client.
- Local workspaces. Files in SSH or other remote workspaces open with highlighting only.
- PHPantom 1.1.0 or newer. You don't have to install it yourself (see below).
- `php` on the `PATH` Orca starts with, needed only for PHPStan, PHPCS and PHPMD.

## Frameworks

Nothing needs switching on. Open a file in the project and try these.

### Laravel and Blade

- `view('welcome')` in `routes/web.php` goes to `resources/views/welcome.blade.php`, and
  `config('app.name')` goes to the `name` line in `config/app.php`.
- Eloquent model properties such as `email` complete after `$this->user->`. In Blade, `$loop` inside
  `@foreach` is typed, so `$loop->` completes `index`, `first` and `last`.
- `<livewire:class-counter />` goes to `app/Livewire/ClassCounter.php` for a class component (made
  with `make:livewire --class`). `route('posts.index')` for a Folio page goes to
  `resources/views/pages/posts/index.blade.php` and is not flagged as an unknown route.

More in [PHPantom's Laravel example](https://github.com/PHPantom-dev/phpantom_lsp/tree/1.1.0/examples/laravel).

### Symfony

- A service ID such as `'app.welcome_mailer'` in a controller goes to its definition in
  `config/services.php`. A template name such as `'demo/index.html.twig'` goes to the Twig file,
  which opens in Orca's editor.
- Route names complete inside `generateUrl('')`, and an unknown one such as `'app_demoo'` is flagged.

More in [PHPantom's Symfony example](https://github.com/PHPantom-dev/phpantom_lsp/tree/1.1.0/examples/symfony).

### WordPress

- Core's functions and classes come from `php-stubs/wordpress-stubs`, so install it with Composer
  (`composer require --dev php-stubs/wordpress-stubs`). Hover on the result of `get_post()` then
  shows `WP_Post|null`, and `$wpdb->` completes methods such as `get_var()` and `prepare()`.
- A hook name in a theme's `functions.php` goes to the `do_action()` call that fires it.

More in [PHPantom's WordPress example](https://github.com/PHPantom-dev/phpantom_lsp/tree/1.1.0/examples/wordpress).

### Drupal

- `.module` and `.theme` files open in PHPantom's editor. A hook's parameters are typed from core's
  interfaces, so `$route_match->` in `hook_help()` completes `getRouteName()`.
- A service ID such as `'acme.greeter'` goes to its entry in the module's `.services.yml`, which
  opens in Orca's editor. A method called on an injected service goes to the service class.

More in [PHPantom's Drupal example](https://github.com/PHPantom-dev/phpantom_lsp/tree/1.1.0/examples/drupal).

### Yii 3

- In `config/common/routes.php`, a route's action name goes to the controller method.
- Route names complete inside `generate('')` in a view and go to the route that names them.
- An argument that no route has, such as `#[RouteArgument('slugg')]`, is flagged.

More in [PHPantom's Yii example](https://github.com/PHPantom-dev/phpantom_lsp/tree/1.1.0/examples/yii).

### Tempest

- `.view.php` views open in PHPantom's editor, and a loop variable inside them is typed, so
  `{{ $book-> }}` completes the book's `title` and `summary()`.
- A view path in a controller, such as `'/books.view.php'`, goes to the view file.
- Route URIs complete inside `uri('')`.

More in [PHPantom's Tempest example](https://github.com/PHPantom-dev/phpantom_lsp/tree/1.1.0/examples/tempest).

### PHPUnit and Pest

- `assertInstanceOf()` narrows a nullable variable: after it, hover on `$value` shows
  `DateTimeImmutable` without `null`.
- The name in `#[DataProvider('cases')]` goes to the `cases()` method.
- In a Pest test, `$this` is the test case that `tests/Pest.php` binds, so `$this->` completes
  `get()` and the other test helpers.

More in [PHPantom's feature list](https://github.com/PHPantom-dev/phpantom_lsp#context-aware-intelligence).

## Static analysis

PHPantom runs PHPStan, PHPCS, PHPMD and Mago itself when it finds them, and shows their results
beside its own. PHPStan and PHPCS were tested through this plugin, with the gaps listed under Known
gaps. PHPMD, Mago and the settings below are PHPantom's documented behaviour, not tested here.

| Tool | Runs when | Keys in `.phpantom.toml` |
| --- | --- | --- |
| PHPStan | `vendor/bin/phpstan` (then `PATH`) exists and the project has a PHPStan config file or requires `phpstan/phpstan` or a Laravel PHPStan extension such as Larastan directly. A Laravel app with neither such an extension nor a config file is left alone | `[phpstan]` `command`, `memory-limit` (default `"1G"`), `timeout` (default `60000`) |
| PHPCS | `vendor/bin/phpcs` or `phpcs` on `PATH` exists | `[phpcs]` `command`, `standard` (such as `"PSR12"`), `timeout` (default `30000`) |
| PHPMD | PHPMD 3 is installed and the project has a PHPMD config file, or `ruleset` is set | `[phpmd]` `command`, `ruleset`, `timeout` (default `30000`) |
| Mago | `mago.toml` is at the project root: `lint` runs when it has a `[linter]` table, `analyze` when it has `[analyzer]` | `[mago]` `command`, `lint`, `analyze` |

PHPantom documents that `command = ""` switches a tool off and `command = "path/to/tool"` uses
another binary, and that `[diagnostics]` `workspace = true` also checks unopened files in the
background. For example, to check against PSR-12 and switch PHPStan off:

```toml
[phpcs]
standard = "PSR12"

[phpstan]
command = ""
```

All the keys are in [PHPantom's configuration reference](https://phpantom-dev.github.io/phpantom_lsp/1.1.0/configuration/).

## File types

| Files | Opens in | Notes |
| --- | --- | --- |
| `.php` | PHPantom's editor | Includes Tempest's `.view.php` views |
| `.blade.php` | PHPantom's Blade editor | |
| `.module`, `.install`, `.theme`, `.profile`, `.inc`, `.engine` | PHPantom's editor | Drupal's PHP files. They open here in every project, and one that isn't PHP still shows as plain text; to see it in Orca's editor, pick Source with the view toggle. Outside a Drupal site, add them, without the dot, to `[indexing]` `extensions` in `.phpantom.toml` so PHPantom also indexes the ones you haven't opened |
| `.twig` | Orca's editor | Not supported yet, see [issue #3](https://github.com/noppu-labs/orca-phpantom/issues/3) |
| `.yaml`, `.yml`, `.xml`, `.env` | Orca's editor | This plugin doesn't open them |

## Finding the PHPantom binary

The plugin uses the first `phpantom_lsp` it finds here:

1. The `phpantomPath` setting, if you set one.
2. Your `PATH`, then `/opt/homebrew/bin`, `/usr/local/bin` and `~/.cargo/bin` (on Windows,
   `%USERPROFILE%\.cargo\bin`), in case Orca started without your shell's `PATH`.
3. A copy it downloaded earlier.
4. A fresh download of PHPantom 1.1.0 from GitHub, checked against its SHA-256, if `allowDownload` is on.

If `phpantomPath` doesn't point at a working `phpantom_lsp`, the plugin shows an error and doesn't
try the other places. A copy on `PATH` older than 1.1.0 is skipped. Downloads go to the plugin's
cache folder (on macOS, `~/Library/Caches/noppu-labs.phpantom`). Hover the PHPantom item in the
status bar to see which binary is in use.

## Commands

- `PHPantom: Show status` (or a click on the status bar item) lists the binary, the running servers
  and the open files with their error counts.
- `PHPantom: Restart language servers` stops every PHPantom the plugin started, and open editors
  start them again within seconds. Run it after installing PHPantom or after a failed download.

## Settings

- `phpantomPath`: full path to `phpantom_lsp`. Leave it empty to use `PATH` or the download.
- `allowDownload`: whether the plugin may download PHPantom when none is installed. On by default.

## Colouring

PHPantom's default `contextual` colouring marks parameters, template parameters, deprecated
symbols and static member references, and leaves the rest to the editor's own highlighting. For
full colouring, add this to `.phpantom.toml` at the project root:

```toml
[semantic-tokens]
mode = "full"
```

## Using it with Autocomplete

[Autocomplete](https://github.com/actus7/orca-autocomplete) also opens `.php` files in its own
editor, so with both plugins on, only one of them opens a PHP file. Which one wins is not confirmed
yet; see [docs/smoke/v1-smoke.md](docs/smoke/v1-smoke.md). To switch a file to PHPantom, use the
view toggle at the top right of the editor tab, beside Source.

## Known gaps

- Twig templates ([issue #3](https://github.com/noppu-labs/orca-phpantom/issues/3)), Symfony's YAML
  and XML files, Drupal's `.yml` files and `.env` open in Orca's editor, without PHPantom's
  completion and navigation. Going to a definition from PHP still opens a Twig template or a
  Drupal `.services.yml` file.
- Code lenses and workspace symbol search are not shown.
- Livewire 4's single-file components (the `make:livewire` default) don't resolve or complete in a
  `<livewire:...>` tag, a gap PHPantom 1.1.0 lists itself. Class components work.
- In a Drupal site, opening a file under `web/core` (say, by going to `ControllerBase`) starts a
  second PHPantom for `web/core`, which has its own `composer.json`. That server doesn't see the
  project's `vendor/`, so it flags Symfony classes such as `RedirectResponse` as unknown there.
- Go to definition opens a very large file such as the 6 MB `wordpress-stubs.php`, but its tab
  attached to PHPantom in only one of four tries, so hover and navigation in it may not work.
- PHPStan and PHPCS results may not appear for a file opened while PHPantom is still starting. In
  our test that first open got none in 90 seconds; opening it again later showed them within 5 seconds.
- PHPStan and PHPCS results stay as they were after you edit. The plugin doesn't tell PHPantom when
  you save, and saving is what made PHPantom run them in a test outside Orca.
- PHPantom documents that most `.phpantom.toml` changes apply within seconds, and that the PHP
  version and indexing strategy need a restart. We haven't checked this through the plugin, so if a
  change has no effect, run `PHPantom: Restart language servers`.
- Rename works within the open file only. A rename or quick fix that would touch other files is refused.
- Inlay hints are off in Blade files, where PHPantom 1.1.0 adds stray ones such as `value:` after `{{`.
- The outline can come up empty for a very large class, such as one with 5,820 methods.
- A tab whose file the plugin can't identify gets highlighting only and tries again after you save.
- A `vendor/` tab opened by go to definition gets highlighting only when you switch back to it
  with unsaved edits, or after Orca restarted the plugin.
- Undo history and the cursor position reset when you switch back to a tab; unsaved text is kept.
- After a failed download the plugin waits two minutes to retry. Changing a setting or running
  `PHPantom: Restart language servers` retries at once.
- A tab that was already open when the plugin loaded may not attach until you open it again.
- A file changed on disk while its workspace is in the background updates only when you switch back.
- Errors and warnings appear a moment after a file opens. In a big project the first completions
  wait for indexing, which the status bar shows as `indexing`.
- PHPantom lets go of a file about three minutes after you close its tab or switch away from it.

The test runs behind this README, with checklists for what needs a person at the keyboard, are in
[docs/smoke/v1-smoke.md](docs/smoke/v1-smoke.md) and [docs/smoke/frameworks-smoke.md](docs/smoke/frameworks-smoke.md).

## Credits

- [PHPantom](https://github.com/PHPantom-dev/phpantom_lsp) does all the PHP and framework work.
- Parts of the language server plumbing, the binary lookup and the editor come from
  [Autocomplete](https://github.com/actus7/orca-autocomplete) by actus7 (MIT), see `THIRD_PARTY_NOTICES.md`.

## License

MIT. See `LICENSE` and `THIRD_PARTY_NOTICES.md`.
