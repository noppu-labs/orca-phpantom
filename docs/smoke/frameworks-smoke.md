# Framework smoke run

Date: 2026-11-27. Orca 1.4.278 on macOS arm64, PHPantom 1.1.0 from Homebrew
(`/opt/homebrew/bin/phpantom_lsp`), PHP 8.5.13, Composer 2.10.1. Plugin commit `11b9f9c` on
`docs/frameworks` (the `php` editor opens `.php`, `.module`, `.install`, `.theme`, `.profile`, `.inc`
and `.engine`).

## How it was run

- PHPantom's examples were cloned at the tag that matches the binary
  (`git clone --depth 1 --branch 1.1.0 https://github.com/PHPantom-dev/phpantom_lsp`, commit
  `3d1fbc9`) into a temporary folder outside the plugin repo, written `<fw>` below. Every anchor in
  the table was checked against that clone before it was used; the one line that moved is named in
  its row (D2).
- Seven fixtures, each committed to a new Git repo and added with `orca repo add`:
  - `<fw>/phpantom-fw-symfony`, `-wordpress`, `-drupal`, `-yii` and `-tempest`: copies of
    `examples/<name>` with `composer install` run in each. Locked versions: Symfony framework-bundle
    7.4.15; WordPress 7.1.4 (`roots/wordpress-no-content`) with `php-stubs/wordpress-stubs` 7.1.2;
    Drupal core 11.4.11, installed under `web/core`; `yiisoft/router` 4.0.2; Tempest router and view
    3.21.0.
  - `<fw>/phpantom-fw-laravel`: `composer create-project laravel/laravel` (Laravel 13.44.1), then
    `composer require --dev pestphp/pest --with-all-dependencies` (Pest 4.7.8, PHPUnit 12.5.33),
    `./vendor/bin/pest --init`, `composer require livewire/livewire laravel/folio` (Livewire 4.4.10,
    Folio 1.4.0), `php artisan folio:install` and `php artisan make:livewire Counter`. That last
    command made a single-file component, `resources/views/components/⚡counter.blade.php`, not a
    class (Livewire 4's default). Added files: `tests/Unit/NarrowTest.php`,
    `tests/Feature/PestSmokeTest.php`, `resources/views/smoke-livewire.blade.php`,
    `resources/views/pages/posts/index.blade.php` and `app/Smoke/Links.php`. The two tests are
    short: `NarrowTest` narrows a nullable `DateTimeImmutable` after `assertInstanceOf` and has a
    `#[DataProvider('cases')]`; `PestSmokeTest` is one `it()` that calls `$this->get('/')`. The Livewire
    view holds `<livewire:counter />`, the Folio page names its route `posts.index`, and `Links` has one
    method that returns `route('posts.index')`.
    Made during the run: `resources/views/smoke.blade.php` (LV3), and for the extra row L1-class
    `php artisan make:livewire ClassCounter --class` plus `resources/views/smoke-livewire-class.blade.php`.
  - `<fw>/phpantom-fw-analysis`: a second copy of `examples/symfony`, then
    `composer require --dev phpstan/phpstan squizlabs/php_codesniffer` (PHPStan 2.3.7, PHP_CodeSniffer
    4.0.4), with `phpstan.neon` (`level: 6`, `paths: [src]`), `phpcs.xml` (only
    `<rule ref="PSR12"/>`) and `src/Smoke/Analysed.php`. Run from the shell, PHPStan and PHPCS each
    report the intended error on that file. Made during the run: `.phpantom.toml` (A3),
    `src/Smoke/AnalysedTwo.php` (A3) and `notes.inc` (X1).
  - Every Composer step succeeded.
- The plugin ran under `orca plugin dev load .` as `local.phpantom`. The installed
  `noppu-labs.phpantom` 0.1.0 (an older build that claims `.php` and `.blade.php`) stayed installed
  and running beside it. Each plain open of a project file in this run (D0, T1, X1, A1) was listed
  as attached by the development worker, so it went to the development copy's editor.
- Two temporary handlers were added to `src/main.ts` for the run, with a read-only accessor on the
  router, and removed before the commit. `phpantom.smoke` returned `describe()`, the attached
  documents (path, root, session, workspace, whether PHPantom had published diagnostics, the
  diagnostics with message, code, source, severity and range, and on request the text PHPantom holds),
  the worker's `process.pid` and `PATH`, and on request the workspace list. `phpantom.smokeRestart`
  called the `restartAll()` behind `PHPantom: Restart language servers` (used once, in A3).
- A small driver sent the worker the same requests the editor sends, each through
  `orca plugin dev request`: `phpantom.open` (60,000-character chunks, with the fixture's workspace
  id), `phpantom.change`, `phpantom.request`, `phpantom.navigate` and `phpantom.close`, plus
  `phpantom.smoke`. The cursor column was found by searching the anchor text on its line. Times in
  the table include about 0.1 s of CLI start-up per call.
- "Opens in PHPantom's editor" means `orca file open <file> --worktree path:<project> --focus`
  followed by `phpantom.smoke` listing the file as attached. `orca plugin shot --editor` was used
  only afterwards, for a picture. Orca was driven only through the CLI, never by clicking.
- Seen in S1 and D4, not established in general: a tab that `phpantom.navigate` opened in a worktree
  other than the one on screen did not attach until `orca worktree activate` showed that worktree.
  `orca plugin shot` says it shows the previous worktree again afterwards. So before later navigate
  checks the fixture was shown with `orca worktree activate`. The owner was using Orca during the run,
  so the view was not fully under the run's control.
- Polling `phpantom.smoke` every 0.5 s (D0) made the editor log `too many panel requests`, and an
  editor shot taken then showed the note `PHPantom did not answer: too many panel requests`. Later
  polls were 5 s apart and the note did not come back.
- Raw answers were kept beside the run's notes, and none of them is committed. Two gaps: one first
  answer was overwritten (W2-attach says which), and the attach timings in D0, T1 and X1 come from
  the terminal and exist only in those notes.

## Gate

`npm ci && orca plugin types . && npx tsc -p . && orca plugin validate . && orca plugin check . && orca plugin test . && node editor/build.mjs && git diff --exit-code -- editor/dist && git ls-files -z | xargs -0 du -ck | tail -1 && git ls-files | wc -l`

Run at `11b9f9c` after the temporary handlers were removed and the plugin was unloaded. Pass, exit 0.
`orca plugin check`: both editors load 6 files. `orca plugin test`: 253 tests, 253 pass, 25 test
files. `editor/dist` is 4.57 MiB in 8 files and equal to a fresh build. Tracked files total 5,408 K
in 94 files (before this document was added).

## Results

Lines and characters are 1-based. `<fw>` is the folder holding the fixtures. Rows whose ID ends in
`-attach`, `-shot` or `-class` are extra rows that split a check; the planned checks keep their
own IDs.

| ID | Project | Claim | Where | Request | Result | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| S1 | symfony | `app.welcome_mailer` resolves to the service definition and the target opens | `src/Controller/DemoController.php:39`, inside `'app.welcome_mailer'` | definition, then `phpantom.navigate` | Pass | Definition: `config/services.php` line 14 (`$services->set('app.welcome_mailer', WelcomeMailer::class);`), 0.24 s. Navigate: `opened: true`. The tab opened in the background; once the Symfony worktree was shown, `phpantom.smoke` listed `config/services.php` as attached. |
| S2 | symfony | Route names complete inside `generateUrl('')` | `DemoController.php:70`, `'app_demo'` emptied with `phpantom.change`, cursor between the quotes | completion | Pass | 5 items: `_preview_error`, `admin_dashboard`, `app_demo`, `app_demo_legacy`, `app_demo_profile`, 0.13 s. |
| S3 | symfony | A Twig template name resolves to the template and opens | `DemoController.php:89`, inside `'demo/index.html.twig'` | definition, then navigate | Pass | Definition: `templates/demo/index.html.twig` line 1. Navigate: `opened: true`. The target is not PHP, so it does not attach, and no CLI lists editor tabs: the open is shown only by `opened: true`. |
| S4 | symfony | An unknown route name is reported | `DemoController.php:70`, `app_demo` changed to `app_demoo` | `phpantom.smoke` 5 s later | Pass | On the held text `$this->generateUrl('app_demoo', ...)`: source `phpantom`, code `invalid_symfony_route`, severity 2, line 70 col 29, `Unknown route 'app_demoo'`. |
| W1 | wordpress | `get_post()` is typed from the WordPress stubs | `wp-content/plugins/acme-shop/src/ProductRepository.php:15`, on `$post` | hover | Pass | `$post = WP_Post\|null`, 0.12 s. |
| W2 | wordpress | A WordPress function resolves into the stubs and the stub file opens | `wp-content/plugins/acme-shop/src/ProductPostType.php:18`, on `register_post_type` | definition, then navigate | Pass | Definition: `vendor/php-stubs/wordpress-stubs/wordpress-stubs.php` line 153,512 (`function register_post_type($post_type, $args = array())`), 0.13 s. Navigate: `opened: true`. The opened tab did not attach: see W2-attach. |
| W2-attach | wordpress | The stub file attaches after navigate | `vendor/php-stubs/wordpress-stubs/wordpress-stubs.php` (depth 3, inside Composer's `vendor/`, 5,956,981 bytes) | navigate, then `phpantom.smoke` every 5 s | Fail | With the WordPress worktree shown, the stub tab attached after 1 of 4 navigates. Shown means a navigate from the same document to `vendor/composer/InstalledVersions.php` (17,395 bytes, also in `vendor/`), sent with no view change, attached within 5 s every time it was tried. The four: after `orca worktree activate`, not attached at any poll for 90 s; right after the small file, attached within 5 s; after `orca plugin restart local.phpantom`, not attached in 45 s; after a navigate to the small file and back, not attached in 45 s. Two earlier tries with the view not controlled (6 to 25 s, and 90 s) did not attach either. A synthetic `phpantom.open` of the same text with no pending reveal answered `single-file` / `no-file`. That was seen in the terminal only: its raw answer was overwritten by the next open and is not kept. The walk skips `vendor/` beside a `composer.json`. A synthetic open sent within 30 s of a navigate answered `ready` after 14 s for 100 chunks; this raw answer is kept. That the real tab got `single-file` is inferred, not seen. The editor shows the file either way (an editor shot paints it). Cause not established. |
| W3 | wordpress | A hook name resolves to the `do_action()` that fires it | `wp-content/themes/acme-theme/functions.php:63`, inside `'acme_shop_product_created'` | definition | Pass | `wp-content/plugins/acme-shop/src/ProductRepository.php` line 75, `do_action('acme_shop_product_created', $id);`, 0.61 s. |
| W4 | wordpress | `$wpdb` members complete | `ProductRepository.php:94`, cursor right after `$wpdb->` | completion | Pass | 104 items, including `get_var($query = ..., $x = ..., $y = ...)` (detail `non-empty-string\|null`) and `prepare($query, ...$args)`, 0.13 s. |
| D0 | drupal | `.module` and `.theme` files open in PHPantom's editor and attach to the project's server | `web/modules/custom/acme/acme.module`, `web/themes/custom/acme_theme/acme_theme.theme`, core installed under `web/core` | `orca file open --focus` for each, then `phpantom.smoke` | Pass | After a plain open each was listed as attached, root `<fw>/phpantom-fw-drupal`, server `ready`. Time from `orca file open` to the first `phpantom.smoke` that listed it (polled every 0.5 s, CLI start-up included): 1.6 s for `acme.module`, 1.7 s for `acme_theme.theme`. The highlighting half is in D0-shot. |
| D0-shot | drupal | The same files are highlighted as PHP | the same two files | `orca plugin shot --editor`, then a check by hand | Pass | Passed on the owner's hand check on Orca 1.4.278, after the run: keywords, strings, comments, PHPantom's semantic tokens and inlay hints all show. The screenshots taken during the run showed bracket-pair colours only, for `.module`, `.theme`, `.php` and Blade alike, so they were an artefact of the shots. Code: the editor builds every model with the language `php` whatever the extension (`editor/src/editor.ts`, `createModel('', language, ...)`), so `.module` and `.theme` get the same highlighting as `.php`. The first pair of shots also showed the note `PHPantom did not answer: too many panel requests`, likely from this run's 0.5 s polling; it was gone from shots taken after 20 quiet seconds. |
| D1 | drupal | Core interfaces type a procedural hook's parameters | `acme.module:33-36`, `        $route_match->` inserted as line 37 inside `acme_help()` | completion | Pass | 6 items: `getParameter($parameter_name)`, `getParameters()`, `getRawParameter($parameter_name)`, `getRawParameters()`, `getRouteName()`, `getRouteObject()`, 0.12 s. |
| D2 | drupal | A service ID resolves to the services file | `acme.module:42` (the expected 39-41 are the comment above it), inside `'acme.greeter'` | definition, then navigate | Pass | Definition: `web/modules/custom/acme/acme.services.yml` line 5 (`  acme.greeter:`), 0.13 s. Navigate: `opened: true` (a YAML target does not attach; no CLI lists editor tabs). |
| D3 | drupal | A method on an injected service resolves | `web/modules/custom/acme/src/Controller/GreetingController.php:38`, on `greet` in `$this->greeter->greet(` | definition | Pass | `web/modules/custom/acme/src/Greeter.php` line 23, `public function greet(string $name): string`, 0.13 s. |
| D4 | drupal | Core classes resolve into `web/core` and open there without a second server | `GreetingController.php:16`, on `ControllerBase` | definition, navigate, `phpantom.smoke`, `pgrep -fl phpantom_lsp` | Fail | Definition: `web/core/lib/Drupal/Core/Controller/ControllerBase.php` line 35 (`abstract class ControllerBase implements ContainerInjectionInterface {`). Navigate: `opened: true`, and the tab attached within 5 s once the Drupal worktree was shown. It attached to a second server: describe listed `<fw>/phpantom-fw-drupal/web/core: ready, 1 open document(s)` beside `<fw>/phpantom-fw-drupal`, and `pgrep` showed a new `phpantom_lsp --stdio` whose working folder is `web/core` (core ships its own `composer.json`). That server reported `unknown_class` for `Symfony\Component\HttpFoundation\RedirectResponse` and `Symfony\Component\DependencyInjection\ContainerInterface` in `ControllerBase.php`, since those live in the project's `vendor/`. |
| Y1 | yii | A route's action resolves to the controller method | `config/common/routes.php:32`, inside `'view'` | definition | Pass | `src/Web/Blog/PostController.php` line 60, `public function view(#[RouteArgument('slug')] string $slug): ResponseInterface`, 0.16 s. |
| Y2 | yii | A route name resolves to its route and completes | `resources/views/blog/index.php:25`, inside `'blog/post'`; then the string emptied | definition, then completion | Pass | Definition: `config/common/routes.php` line 33, characters 25-28, the `post` in `->name('post')`, 0.17 s. Completion inside `generate('')`: 4 items, `blog/comment`, `blog/index`, `blog/post`, `home`, 0.18 s. |
| Y3 | yii | An unknown route argument is reported | `src/Web/Blog/PostController.php:60`, `'slug'` changed to `'slugg'` in `#[RouteArgument('slug')]` | `phpantom.smoke` 5 s later | Pass | On the held text `#[RouteArgument('slugg')]`: source `phpantom`, code `invalid_yii_route_argument`, severity 2, line 60 col 43, `Unknown route argument 'slugg'`. |
| T1 | tempest | A `.view.php` file opens in PHPantom's editor and its loop variable is typed | `app/books.view.php:3`; `summary()` removed from `{{ $book->summary() }}` on line 6 | `orca file open --focus`, `phpantom.smoke`, then completion after `$book->` | Pass | After a plain open, listed as attached (root `<fw>/phpantom-fw-tempest`) 1.0 s after `orca file open`. Completion on `<p>{{ $book-> }}</p>`: 2 items, `title` (`string`) and `summary()` (`string`), 0.14 s. |
| T2 | tempest | A view path resolves to the view file | `app/BookController.php:20`, inside `'/books.view.php'` | definition | Pass | `app/books.view.php` line 1, 0.13 s. |
| T3 | tempest | Route URIs complete inside `uri('')` | `app/RouteLinks.php:18`, the string in `uri('/admin/v1/books/{book}', ...)` emptied | completion | Pass | 4 items: `/admin/books`, `/admin/v1/books/{book}` (detail `GET — App\BookController::show`), `/api/home/{locale}`, `App\HomeController`, 0.13 s. |
| LV1 | laravel fixture | A view name resolves to the Blade file, which opens in the Blade editor and attaches | `routes/web.php:6`, inside `'welcome'` in `view('welcome')` | definition, then navigate | Pass | Definition: `resources/views/welcome.blade.php` line 1, 0.13 s. Navigate: `opened: true`; within 5 s `phpantom.smoke` listed `resources/views/welcome.blade.php` as attached to the project's server. The plugin's only editor for `.blade.php` is `blade`; a later editor shot answered `editorId: blade`. |
| LV2 | laravel fixture | A config key resolves to its line in the config file | `app/Smoke/Links.php`, line 11 added: `public function appName(): mixed { return config('app.name'); }`, cursor inside `'app.name'` | definition | Pass | `config/app.php` line 16, characters 6-9: the `name` in `'name' => env('APP_NAME', 'Laravel'),`, 0.14 s. |
| LV3 | laravel fixture | Blade's `$loop` is typed and completes | new `resources/views/smoke.blade.php`: `@foreach ([1, 2] as $n) {{ $loop->index }} @endforeach`, on `$loop`; then `index` removed | hover, then completion after `$loop->` | Pass | Hover: `$loop = object{index: int, iteration: int, remaining: int, count: int, first: bool, last: bool, even: bool, odd: bool, depth: int, parent: ?object{...}}`. Completion: 10 items, `count`, `depth`, `even`, `first`, `index` (`int`), `iteration`, `last`, `odd`, `parent`, `remaining`. |
| U1 | laravel fixture | `assertInstanceOf` narrows a nullable variable | `tests/Unit/NarrowTest.php:20`, on `$value` in `$value->format('c')` | hover | Pass | `$value = DateTimeImmutable` (no `null`), 0.15 s. |
| U2 | laravel fixture | A `#[DataProvider]` name resolves to its method | same file, line 15, inside `'cases'` | definition | Pass | Same file, line 10, character 28: the `cases` in `public static function cases(): array`, 0.17 s. |
| P1 | laravel fixture | Pest closures bind `$this` to the configured test case | `tests/Feature/PestSmokeTest.php:4`, on `$this`; then `get('/')->assertOk();` removed | hover, then completion after `$this->` | Pass | Hover: `namespace Tests;` `$this = TestCase` (`Tests\TestCase`, from `pest()->extend(TestCase::class)->in('Feature')` in `tests/Pest.php`). Completion: 347 items, including `get($uri, $headers = ...)` with detail `TestResponse`. |
| L1 | laravel fixture | A `<livewire:...>` tag resolves to the component and completes | `resources/views/smoke-livewire.blade.php`, on `counter` in `<livewire:counter />`; then `counter />` removed | definition; then completion after `<livewire:` | Fail | `make:livewire Counter` (Livewire 4.4.10) made a single-file component, `resources/views/components/⚡counter.blade.php`, not a class. Definition answered `null`; completion after `<livewire:` answered 0 items. PHPantom 1.1.0's own `docs/todo/laravel.md` (L29) lists this gap: "Volt and Livewire v4 single-file components ... are not indexed, so `<livewire:…>` naming one resolves to nothing." |
| L1-class | laravel fixture | The same with a class component (extra row, not in the planned checks) | `php artisan make:livewire ClassCounter --class` (made `app/Livewire/ClassCounter.php`), new `resources/views/smoke-livewire-class.blade.php` holding `<div><livewire:class-counter /></div>` | definition; then completion after `<livewire:` | Pass | Definition: `app/Livewire/ClassCounter.php` line 7, 0.12 s. Completion: 1 item, `class-counter`, detail `\App\Livewire\ClassCounter`. |
| F1 | laravel fixture | A Folio page's route name resolves and is not reported unknown | `app/Smoke/Links.php:9`, inside `'posts.index'` | definition, then `phpantom.smoke` | Pass | Definition: `resources/views/pages/posts/index.blade.php` line 1, 0.13 s. `phpantom.smoke` 4 s later: `published: true`, held text `return route('posts.index');`, no diagnostics. Control: changed to `'posts.indexx'`, the same smoke reported `invalid_laravel_route`, `Unknown route 'posts.indexx'`; changed back, it was gone. |
| A1 | analysis fixture | PHPStan's diagnostics reach the editor | `src/Smoke/Analysed.php` (`phpstan.neon`: level 6, `paths: [src]`; `phpstan/phpstan` 2.3.7 in `require-dev`) | `phpantom.smoke`, polled for up to 90 s | Pass | A plain `orca file open --focus` of the file, on a server that had been running for several minutes, gave within 5 s: source `phpstan`, code `missingType.iterableValue`, severity 1, line 6, `Method App\Smoke\Analysed::size() has parameter $items with no value type specified in iterable type array.` But the first open of the same file, sent while its server was starting, got no PHPStan or PHPCS diagnostic in 90 s of polling, and neither did the first open after a restart (A3). A standalone run of `phpantom_lsp --stdio` outside Orca showed the same: nothing after `didOpen` in 45 s, then both tools within 1 s of a `didSave`. The plugin never sends `didSave` (`synchronization: { didSave: false }` in `src/lsp/capabilities.ts`). So the diagnostic was seen on a re-open of the file on a server that was already running; the first open while the server was starting got none in 90 s. |
| A2 | analysis fixture | PHPCS's diagnostics reach the editor | same file (`phpcs.xml` with `<rule ref="PSR12"/>`; `squizlabs/php_codesniffer` 4.0.4 in `require-dev`) | same | Pass | Same answer as A1: source `phpcs`, code `PSR2.Classes.ClassDeclaration.OpenBraceNewLine`, severity 1, line 5, `Opening brace of a class must be on the line after the definition`. The same first-open gap as A1 applies. |
| A3 | analysis fixture | `command = ""` under `[phpstan]` turns PHPStan off and leaves PHPCS on | `.phpantom.toml` holding `[phpstan]` and `command = ""`, 10 s wait, then a one-line `phpantom.change` | `phpantom.smoke`; then the servers restarted | Not run | Inconclusive: no control on the restarted server, and A1 shows PHPStan and PHPCS can both be missing after a start. After the change, both diagnostics were still listed (the tools did not run again on a change). The servers were restarted through the temporary handler (`restartAll()`, `stopped 6 server(s)`). On `Analysed.php` the first open after the restart got no external diagnostics at all (the A1 gap), so the check moved to a twin file, `src/Smoke/AnalysedTwo.php` (same code, class renamed), opened once: within 5 s it had only source `phpcs`, code `PSR2.Classes.ClassDeclaration.OpenBraceNewLine`, and no `phpstan` diagnostic 15 s later. Without the file, both tools had answered inside one 5 s poll (A1), well short of PHPStan's 60 s timeout. Whether the setting needs a restart is not shown: the tools never ran again between writing the file and the restart. |
| A4 | analysis fixture | Record the worker's `PATH` and what PHPantom logged about PHPStan | none | `process.env.PATH` from the temporary handler; `orca plugin logs local.phpantom` | Pass | `php` resolves on the worker's `PATH` to `/opt/homebrew/bin/php` (PHP 8.5.13), and `phpantom_lsp` to `/opt/homebrew/bin/phpantom_lsp`. The worker's `PATH` is the login shell's (it includes the user's own tool folders before `/opt/homebrew/bin`). The plugin log has no line about PHPStan: it shows only `Starting PHPantom 1.1.0 for <fw>/phpantom-fw-analysis` and `started`. The worker forwards only PHPantom's error and warning log messages (`window/logMessage` types 1 and 2), and none came. |
| A5 | analysis fixture | PHPMD and Mago diagnostics | `phpmd.xml`, `mago.toml` | `phpantom.smoke` | Not run | Optional. Neither PHPMD 3 nor Mago was installed for this run. |
| X1 | analysis fixture | A `.inc` file that is not PHP | new `notes.inc` holding two lines of plain text | `orca file open --focus`, `phpantom.smoke`, then a shot | Pass | A plain open put it in PHPantom's editor: listed as attached 1.4 s after `orca file open`. PHPCS reported on it: source `phpcs`, code `Internal.NoCodeFound`, severity 2, line 1, `No PHP code was found in this file and short open tags are not allowed by this install of PHP. ...`. The editor shot (`editorId: php`) shows both lines readable as plain text and no error note. |

## Claims for the README

- Symfony: Confirmed (S1, S2, S3, S4).
- WordPress: Partly confirmed (W2-attach failed: go to definition opens the 6 MB stub file, but the file attached to PHPantom after only 1 of 4 navigates; W1 to W4 passed).
- Drupal: Partly confirmed (D4 failed: a file opened under `web/core` started a second PHPantom rooted at `web/core`; D0 to D3 passed).
- Drupal file types `.module` and `.theme` in PHPantom's editor: Confirmed (D0, and D0-shot by the owner's hand check on 1.4.278).
- Yii: Confirmed (Y1, Y2, Y3).
- Tempest: Confirmed (T1, T2, T3).
- Laravel views, config keys and Blade's `$loop`: Confirmed (LV1, LV2, LV3).
- PHPUnit (narrowing by assertions, data providers): Confirmed (U1, U2).
- Pest: Confirmed (P1).
- Livewire: Partly confirmed (L1 failed: Livewire 4's default single-file component from `make:livewire` is not resolved or completed; a class component passed in L1-class).
- Folio: Confirmed (F1).
- PHPStan: Confirmed (A1), with gaps: the first open of a file while its server was starting got no PHPStan or PHPCS diagnostic in 90 s, and the diagnostics did not refresh after a one-line change. The plugin sends no `didSave`, and running on save was not tested in Orca.
- PHPCS: Confirmed (A2), with the same gaps as PHPStan.
- Turning PHPStan off with `[phpstan]` `command = ""`: Not confirmed (A3 inconclusive: no control after restart).
- PHPMD: Not confirmed (A5 not run).
- Mago: Not confirmed (A5 not run).
- A `.inc` file that is not PHP opens in PHPantom's editor and stays readable: Confirmed (X1). PHPCS reports `Internal.NoCodeFound` on it.

## Hand checklist

1. On a `.inc` file that is not PHP, switch the tab to Source with the view toggle at the top right
   of the editor. Close the tab, open the file again, and note whether Orca remembers Source.
2. After installing, look at the plugin's name in Settings → Plugins at a narrow and at a wide
   window. Note whether it is cut off.
3. On Orca 1.4.278, open a `.php`, a `.blade.php` and a `.module` file by hand in PHPantom's editor
   and note whether keywords, strings and comments are coloured. Done after the run by the owner:
   colours show (see D0-shot).

Items 1 and 2 were not run as part of this record.

## Cleanup

The temporary handlers and accessor were removed from `src/` before this document was committed
(`git diff --exit-code -- src/` exits 0), and `orca plugin dev unload .` removed the development
copy. The seven fixture projects were removed from Orca with
`orca project setup-delete --setup <id> --force`, one call each, and their folders and the examples
clone were deleted. After the unload, the installed `noppu-labs.phpantom` took over the fixture tabs
still open and started three servers for them (Laravel, Tempest and Drupal's `web/core`). They had
stopped by the final review: `pgrep -fl phpantom_lsp` listed none rooted at a fixture.
