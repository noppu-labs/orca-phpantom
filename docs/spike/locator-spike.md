# Locator spike: can the editor tell the worker which workspace it is in?

Date: 2026-11-26. Orca 1.4.277 (host API 1.10), macOS. Throwaway plugin `local.phpantom-spike`
(dev-loaded from `$TMPDIR/phpantom-spike`, not committed; code inline below).

## Verdict

**GO** by the plan's Step 4 criteria: in all four A/B trials the editor's
`workspace.readContext().workspaceId` was exactly the `id` of the focused worktree's
`workspace.list` row (`matchedBy: "id"`), and the exact-content search rooted at that row's
`path` returned exactly that worktree's `app/Example.php`.

**Main caveat:** `readContext` names the workspace that is _focused_, not the workspace the
calling frame's tab belongs to. If a frame starts or re-queries while another workspace is
focused, it gets that other workspace. With byte-identical files the content search then
"succeeds" in the wrong worktree. The worker locates correctly only when the frame starts
while its own workspace is already focused. See "Hazards" below; Tasks 8 and 10 must design
for this.

**Blade routing stop condition tripped.** With the editors declared in the brief's order
(`php` first, then `blade`), `.blade.php` opened in the **`php`** editor by default. Declaring
`blade` first fixed it. See Trial C.

## Repo shape

Throwaway git repo `$TMPDIR/phpantom-spike-repo` (branch `main`, one commit) holding
`composer.json`, `app/Example.php`, `app/Models/User.php` and
`resources/views/welcome.blade.php`. It was added with `orca repo add`, and a second Orca
worktree was made with
`orca worktree create --repo id:<repo> --name spike-b --branch spike-b --no-parent --setup skip`
at `~/orca/workspaces/phpantom-spike-repo/spike-b`. `app/Example.php` was byte-identical in
both (same sha1). In the logs, worktree A is `main` and worktree B is `spike-b`.

Focus was driven with `orca worktree activate --worktree path:<A|B>`. Each A/B trial ran
`orca plugin open local.phpantom-spike --editor <abs path>`.

Another person was switching workspaces in the same Orca window during the run: the logs show
focus moving to unrelated workspaces while no command was running. Every trial result below was
checked against the timestamps of the commands that produced it.

## Trials (raw log lines; terminal arrays trimmed, `$TMPDIR` and `~` abbreviated)

### A1: open `app/Example.php` in A (A focused)

```
06:36:02.841Z [editor php wu3loa caller=php/CWi2wtzdYITD] start vis=visible ctx={"workspaceId":"identity:wt2:local:87f531aa-5632-4f09-b94b-f87eceb5ce44","branch":"main","displayName":"main"}
06:36:02.841Z locate[wu3loa] list total=24 truncated=false spikeRows=[{"id":"identity:wt2:local:87f531aa-5632-4f09-b94b-f87eceb5ce44","kind":"worktree","name":"main","branch":"main","path":"$TMPDIR/phpantom-spike-repo","hostId":"local"},{"id":"identity:wt2:local:a6a73201-5863-4ef7-acec-ad2827c500ec","kind":"worktree","name":"spike-b","branch":"spike-b","path":"~/orca/workspaces/phpantom-spike-repo/spike-b","hostId":"local"}]
06:36:02.841Z locate[wu3loa] idMatches=1 branch+nameMatches=12
06:36:02.843Z locate[wu3loa] => {"matchedBy":"id","path":"$TMPDIR/phpantom-spike-repo","matches":["app/Example.php"]}
```

### A2: same file again (A focused)

Deviation: the CLI cannot close an editor tab (`orca tab close` covers browser tabs only), and
running `plugin open --editor` on the already-open file just reused the tab without starting a new
frame. So A2 forced a fresh frame in the same tab by editing a plugin file, which made Orca reload
it.

```
06:36:34.569Z [editor php xcstwg caller=php/CWi2wtzdYITD] start vis=visible ctx={"workspaceId":"identity:wt2:local:87f531aa-5632-4f09-b94b-f87eceb5ce44","branch":"main","displayName":"main"}
06:36:34.584Z locate[xcstwg] idMatches=1 branch+nameMatches=12
06:36:34.585Z locate[xcstwg] => {"matchedBy":"id","path":"$TMPDIR/phpantom-spike-repo","matches":["app/Example.php"]}
```

### B1: open `app/Example.php` in B (B focused)

```
06:36:50.873Z [editor php ely35u caller=php/CWi2wtzdYITD] start vis=visible ctx={"workspaceId":"identity:wt2:local:a6a73201-5863-4ef7-acec-ad2827c500ec","branch":"spike-b","displayName":"spike-b"}
06:36:50.875Z locate[ely35u] idMatches=1 branch+nameMatches=1
06:36:50.876Z locate[ely35u] => {"matchedBy":"id","path":"~/orca/workspaces/phpantom-spike-repo/spike-b","matches":["app/Example.php"]}
```

### B2: same file again (B focused), via a frame reload as in A2

The reload restarted **both** open frames, A's tab and B's tab. Both reported B, including the
frame in A's tab:

```
06:37:07.762Z [editor php cn967r caller=php/CWi2wtzdYITD] start vis=visible ctx={"workspaceId":"identity:wt2:local:a6a73201-5863-4ef7-acec-ad2827c500ec","branch":"spike-b","displayName":"spike-b"}
06:37:07.762Z [editor php a57qmb caller=php/CWi2wtzdYITD] start vis=visible ctx={"workspaceId":"identity:wt2:local:a6a73201-5863-4ef7-acec-ad2827c500ec","branch":"spike-b","displayName":"spike-b"}
06:37:07.769Z locate[a57qmb] => {"matchedBy":"id","path":"~/orca/workspaces/phpantom-spike-repo/spike-b","matches":["app/Example.php"]}
06:37:07.769Z locate[cn967r] => {"matchedBy":"id","path":"~/orca/workspaces/phpantom-spike-repo/spike-b","matches":["app/Example.php"]}
```

Supporting fresh-tab opens: `orca file open app/Models/User.php --worktree path:<A> --focus`
with A focused gave `matchedBy:"id"`, `matches:["app/Models/User.php"]` under A. The same in B,
with B focused, gave the same result under B.

### Extra: tab mounted while switching workspaces (a stand-in for the restart half of Trial G; equivalence untested)

Each run used an untracked `app/OnlyA.php`/`app/OnlyA2.php` with content unique to A, opened while B was focused.

1. `orca file open app/OnlyA.php --worktree path:<A>` (no `--focus`): no frame started. The
   frame started only when A was activated afterwards, and at that moment `readContext` still
   answered B. `workspace.changed` to A arrived 190 ms later.
2. `orca file open app/OnlyA2.php --worktree path:<A> --focus`: the same thing happened, with
   the change to A arriving 210 ms later.

```
06:44:27.808Z [editor php yd0yxo caller=php/CWi2wtzdYITD] start vis=visible ctx={"workspaceId":"identity:wt2:local:a6a73201-…","branch":"spike-b","displayName":"spike-b"}
06:44:27.811Z locate[yd0yxo] => {"matchedBy":"id","path":"~/orca/workspaces/phpantom-spike-repo/spike-b","matches":[]}
06:44:28.002Z [editor php yd0yxo] workspace.changed ctx={"workspaceId":"identity:wt2:local:87f531aa-…","branch":"main","displayName":"main"}
06:44:59.457Z [editor php 49tq6e caller=php/CWi2wtzdYITD] start vis=visible ctx={"workspaceId":"identity:wt2:local:a6a73201-…","branch":"spike-b","displayName":"spike-b"}
06:44:59.458Z locate[49tq6e] => {"matchedBy":"id","path":"~/orca/workspaces/phpantom-spike-repo/spike-b","matches":[]}
06:44:59.668Z [editor php 49tq6e] workspace.changed ctx={"workspaceId":"identity:wt2:local:87f531aa-…","branch":"main","displayName":"main"}
```

Unique content made these runs miss (`matches: []`). With byte-identical content they would
have returned B's file for A's tab.

### C: default editor (php-first manifest, as in the brief)

The trial used `orca file open <rel> --worktree path:<A> --focus`, which opens a file with its
default editor. Whether clicking in the file tree behaves the same is UNVERIFIED.

| File                                | Editor that loaded (from `caller=<contributionId>` and `textHead`) |
| ----------------------------------- | ------------------------------------------------------------------ |
| `app/Models/User.php`               | `php`                                                              |
| `resources/views/welcome.blade.php` | **`php`** (`caller=php/…`, `textHead="<!doctype html>…"`)          |

Follow-up: declaration order decides, contradicting the manifest reference's "a longer suffix
wins". Moving `blade` to the first slot of `customEditors` needed no new approval. After that, a
fresh `welcome.blade.php` in B opened in **`blade`** (`caller=blade/2viloVLGr8Wk`, located
`resources/views/welcome.blade.php` under B), and `app/Models/User.php` in B still opened in
`php`. With `php` back in the first slot, a fresh `resources/views/other.blade.php` opened in
`php` again. That is three fresh-file opens plus the `.php` control. `.php` itself opens in the
plugin editor by default, not in Orca's Source.

### D: `editor.open` via `orca plugin dev request … spike.open`

| `workspaceId`                             | `path`                                           | Result                                                                   |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------ |
| A (`identity:wt2:local:87f5…`)            | `app/Models/User.php`                            | `{"opened":true}`                                                        |
| A                                         | absolute path under `/private/var/…` (real path) | `invalid_params`: "path: path must be relative and inside the workspace" |
| A                                         | absolute path under `/var/…` (symlinked form)    | `invalid_params`, same message                                           |
| A                                         | B's absolute path                                | `invalid_params`, same message                                           |
| A                                         | `/etc/hosts`                                     | `invalid_params`, same message                                           |
| A                                         | `../../etc/hosts`                                | `invalid_params`, same message                                           |
| A                                         | `app/Nope.php` (missing file)                    | `{"opened":true}` (no existence check)                                   |
| A                                         | `./app/Example.php`                              | `{"opened":true}`                                                        |
| `<repoId>::<path>` (CLI worktree id form) | `app/Models/User.php`                            | `{"opened":true}`                                                        |
| bare instance id `87f5…`                  | `app/Models/User.php`                            | `action_failed`: "This window does not list 87f5…"                       |
| `wt2:local:87f5…`                         | `app/Models/User.php`                            | `action_failed`, same                                                    |

No folder workspace was created by the outside-path calls; the worktree list was unchanged.

### E: worker PATH from a Dock start: not run

Not run, because quitting would have quit the Orca hosting this session. What the dev-loaded
worker logged on activate:

```
PATH=<login-shell PATH: user tool dirs, then /usr/local/bin, system dirs, /opt/homebrew/bin, ~/.cargo/bin, …> (full value trimmed for this public repo)
which phpantom_lsp=/opt/homebrew/bin/phpantom_lsp
```

Indirect evidence: the running Orca's parent process is `launchd` (PPID 1), and its own
environment has `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, which is a LaunchServices start. The worker
still got the full login-shell PATH, so Orca appears to build the worker PATH from the login
shell. That points to a Dock start behaving the same, but this is UNVERIFIED until Trial E is run.

### F: Autocomplete: not run

Not run: `actus7/orca-autocomplete` is not installed.

### G: restart part not run; focus switching run

Not run: the quit/restart part, for the same reason as E. The part that was run: with the file
open in A, focus was switched A → B → A, with the editor logging `visibilitychange`, the
`readContext` result at that moment and 1.5 s later, and `workspace.changed`. Timeline condensed from the raw log:

```
06:38:21.142  (switch to B)  both frames: visibilitychange vis=visible, readContext = main (A)   <- stale
06:38:21.984  both frames: workspace.changed -> spike-b (B)
06:38:22.669  +1500ms: readContext = spike-b (B)
06:38:25.289  (switch to A)  both frames: visibilitychange vis=visible, readContext = spike-b (B) <- stale
06:38:25.580  both frames: workspace.changed -> main (A)
06:38:26.821  +1500ms: readContext = main (A)
```

- `document.visibilityState` was `visible` in every event, for frames in the shown and the
  hidden workspace. No `hidden` was ever observed: a local history buffer in the frame recorded
  only `visible`, and no log request failed.
- `visibilitychange` fires in frames of both worktrees on every switch, sometimes in bursts.
- At `visibilitychange`, `readContext` still answers the _previous_ workspace.
  `workspace.changed` arrives 0.3 to 1.3 s later (another A→B→A run: `visibilitychange` at
  06:37:59.709, `workspace.changed` at 06:38:00.982).

## Answers for later tasks (Interfaces → Produces)

1. **workspaceId → `workspace.list` row (Task 8 `resolveFocused`).** The match is exact by `id`.
   Both have the form `identity:wt2:local:<instanceId>`, which is `"identity:"` plus the CLI's
   `identity.key`. They are not the CLI's `<repoId>::<path>` worktree id. `branch` is the short
   name on both sides (`main`, not `refs/heads/main`), so it needs no normalising.
   `workspace.list` returned 24 rows with `truncated=false`. The `branch+name` fallback is
   ambiguous: `main`/`main` matched **12** rows. Keep it only if it also requires a unique match,
   or never take the first of many.
2. **`editor.open` path form (Task 12).** It takes a workspace-relative path only (`app/x.php`
   and `./app/x.php` both work). Every absolute path, including one inside the workspace, is
   refused with `invalid_params`. It does not check that the file exists. `workspaceId` accepts
   the `identity:…` form from `workspace.list`/`readContext` and the CLI `<repoId>::<path>` form.
3. **`.blade.php` default editor (Task 4).** With `php` declared first it opens the **`php`**
   editor. Declaring `blade` first in `contributes.customEditors` routes `.blade.php` to `blade`
   and leaves `.php` on `php`. A plain `.php` file opens in the plugin's `php` editor by default,
   not in Source.
4. **Worker PATH (Task 5).** Dev-loaded worker: full login-shell PATH, and `phpantom_lsp`
   resolves to `/opt/homebrew/bin/phpantom_lsp`. The Dock case was not tested (see E). The
   indirect evidence suggests it gets the same PATH (UNVERIFIED).
5. **Autocomplete winner (Task 13).** Not tested; Autocomplete is not installed.

## Hazards for the design

- `readContext` is focus-scoped. A frame that mounts during a workspace switch, mounts in a
  background tab, or reloads while another workspace is focused gets the wrong workspace. It
  only corrects itself when `workspace.changed` fires 0.2 to 1.3 s later. Task 10's re-attach
  cannot rely on `visibilitychange` plus `readContext`: visibility is always `visible`, and the
  context is stale at that event.
- The content search cannot catch this when the same file is byte-identical in several
  worktrees. That is the common case.
- `context.panel.id` in a worker handler was the same string for frames in different tabs of
  the same editor contribution (`php/CWi2wtzdYITD` for A's and B's tabs). It changed only when
  the manifest was reloaded. The worker cannot key per-tab state on it, so the frame has to send
  its own id.
- The active tab's frame in a background worktree stays mounted and keeps receiving events
  (each reload restarted one frame per workspace, whose `textHead` matched the file last opened
  there). That inactive tabs' frames are unmounted is inferred, not shown. A frame for a tab
  opened in the background mounts only when its workspace is shown.

## Spike code (as finally run)

`orca-plugin.json` (the brief's order; the blade-first variant swaps the two `customEditors` entries):

```json
{
  "manifestVersion": 2,
  "id": "phpantom-spike",
  "name": "Phpantom Spike",
  "version": "0.1.0",
  "description": "Locator spike: can the editor tell the worker which workspace it is in.",
  "engines": { "orca": ">=1.4.248" },
  "execution": "trusted-worker",
  "pluginApi": 1,
  "main": "worker.ts",
  "capabilities": [{ "kind": "workspace:read" }, { "kind": "workspace:write" }],
  "contributes": {
    "customEditors": [
      {
        "id": "php",
        "title": "PHP (spike)",
        "extensions": [".php"],
        "entry": "php.ts",
        "frame": "isolated"
      },
      {
        "id": "blade",
        "title": "Blade (spike)",
        "extensions": [".blade.php"],
        "entry": "blade.ts",
        "frame": "isolated"
      }
    ]
  }
}
```

`php.ts` (`blade.ts` is identical with `'blade'`):

```ts
import { run } from './editor';
const LANGUAGE = 'php';
await run(LANGUAGE);
```

`editor.ts`:

```ts
export async function run(LANGUAGE: 'php' | 'blade') {
  const frameId = Math.random().toString(36).slice(2, 8);
  const hist: string[] = [];
  let failed = 0;
  const log = (msg: string) =>
    orca.plugin
      .request('spike.log', {
        frameId,
        language: LANGUAGE,
        msg: `${msg} hist=${hist.join(',')} failedLogs=${failed}`,
      })
      .catch(() => {
        failed++;
      });
  const readCtx = async () => {
    try {
      return await orca.host.call('workspace.readContext', {});
    } catch (e: any) {
      return { error: e?.code ?? String(e) };
    }
  };
  const text = document.createElement('textarea');
  text.style.cssText =
    'box-sizing:border-box;width:100%;height:100vh;margin:0;border:0;font:13px monospace';
  document.body.style.margin = '0';
  document.body.append(text);

  const ctx = await readCtx();
  log(`start vis=${document.visibilityState} ctx=${JSON.stringify(ctx)}`);
  document.addEventListener('visibilitychange', async () => {
    const vis = document.visibilityState;
    hist.push(`${new Date().toISOString().slice(14, 23)}:${vis}`);
    log(`visibilitychange vis=${vis} ctx=${JSON.stringify(await readCtx())}`);
    setTimeout(
      async () =>
        log(
          `visibilitychange+1500ms vis=${document.visibilityState} (was ${vis}) ctx=${JSON.stringify(await readCtx())}`
        ),
      1500
    );
  });
  orca.on('workspace.changed', (p) =>
    log(`workspace.changed vis=${document.visibilityState} ctx=${JSON.stringify(p.context)}`)
  );

  const doc = await orca.document!.session<string>();
  text.value = doc.value;
  text.readOnly = true;
  try {
    const answer = await orca.plugin.request('spike.locate', {
      language: LANGUAGE,
      frameId,
      ctx,
      text: doc.value,
    });
    text.title = JSON.stringify(answer);
  } catch (e: any) {
    text.title = `locate failed: ${e?.code ?? e}`;
    log(text.title);
  }
}
```

`worker.ts`:

```ts
import type { OrcaWorkerApi } from 'orca/worker';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP = new Set(['.git', 'vendor', 'node_modules']);
async function walk(
  root: string,
  suffix: string,
  exclude: string | null,
  out: string[] = [],
  dir = root
) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP.has(e.name)) await walk(root, suffix, exclude, out, p);
    } else if (e.name.endsWith(suffix) && !(exclude && e.name.endsWith(exclude))) out.push(p);
  }
  return out;
}

export default function activate(orca: OrcaWorkerApi) {
  orca.log(`activate PATH=${process.env.PATH}`);
  let which = 'not found';
  try {
    which = execFileSync('/usr/bin/which', ['phpantom_lsp'], { encoding: 'utf8' }).trim();
  } catch {}
  orca.log(`activate which phpantom_lsp=${which}`);

  orca.panels.handle('spike.log', (input: any, c) => {
    orca.log(
      `[editor ${input.language} ${input.frameId} caller=${c.panel.contributionId}/${c.panel.id}] ${input.msg}`
    );
    return null;
  });

  orca.panels.handle('spike.locate', async (input: any, c) => {
    const { language, frameId, ctx } = input;
    const text: string = input.text;
    const list = await orca.host.call('workspace.list', {});
    const rows = list.workspaces;
    const spike = rows.filter((r) => r.path.includes('phpantom-spike-repo'));
    orca.log(
      `locate[${language} ${frameId}] caller=${c.panel.contributionId}/${c.panel.id} textLen=${text.length} textHead=${JSON.stringify(text.slice(0, 40))} ctx=${JSON.stringify(ctx)}`
    );
    orca.log(
      `locate[${frameId}] list total=${rows.length} truncated=${list.truncated} spikeRows=${JSON.stringify(spike.map((r) => ({ id: r.id, kind: r.kind, name: r.name, branch: r.branch, path: r.path, hostId: r.hostId })))}`
    );
    const byId = rows.filter((r) => r.id === ctx?.workspaceId);
    const byBranchName = rows.filter(
      (r) => r.branch === ctx?.branch && r.name === ctx?.displayName
    );
    orca.log(
      `locate[${frameId}] idMatches=${byId.length} branch+nameMatches=${byBranchName.length}`
    );
    let matchedBy: 'id' | 'branch+name' | 'none' = 'none';
    let row = byId[0];
    if (row) matchedBy = 'id';
    else if ((row = byBranchName[0])) matchedBy = 'branch+name';
    if (!row) {
      const r = { matchedBy, path: null, matches: [] };
      orca.log(`locate[${frameId}] => ${JSON.stringify(r)}`);
      return r;
    }
    const suffix = language === 'blade' ? '.blade.php' : '.php';
    const files = await walk(row.path, suffix, language === 'blade' ? null : '.blade.php');
    const matches: string[] = [];
    for (const f of files)
      if ((await readFile(f, 'utf8')) === text) matches.push(relative(row.path, f));
    const r = { matchedBy, path: row.path, matches };
    orca.log(`locate[${frameId}] => ${JSON.stringify(r)}`);
    return r;
  });

  orca.panels.handle('spike.open', async (input: any) => {
    try {
      const res = await orca.host.call('editor.open', {
        workspaceId: input.workspaceId,
        path: input.path,
      });
      orca.log(`spike.open ${JSON.stringify(input)} => ${JSON.stringify(res)}`);
      return { ok: res };
    } catch (e: any) {
      const r = { error: e?.code ?? String(e), message: String(e?.message ?? e) };
      orca.log(`spike.open ${JSON.stringify(input)} => ${JSON.stringify(r)}`);
      return r;
    }
  });
}
```

Rerun: `orca plugin dev load <dir>`, approve with the printed `--approve <fingerprint>`, then
`orca plugin logs local.phpantom-spike`.

## Cleanup done

The dev plugin was unloaded. A terminal left in worktree A after the project was removed was
closed with `orca terminal close --tab`; afterwards no process had a spike directory as its
cwd. Worktree `spike-b` was removed (`orca worktree rm --force
--delete-branch`), and the spike project was removed from Orca (`orca project setup-delete
--force`). The throwaway repo and the leftover `~/orca/workspaces/phpantom-spike-repo` directory
were deleted. `repo list`, `worktree list` and `plugin list` show no spike entries. The spike's
editor tabs could not be closed from the CLI; they went away with their workspaces. Focus was set
back to this repo's `feat-v1` workspace. The person's own last switch during the run was to a
different workspace, so the original view was not restored.
