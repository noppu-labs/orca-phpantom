import type { OrcaWorkerApi } from 'orca/worker';
import type { WorkspaceRow } from './locate/workspaces.ts';
import './protocol.ts';
import { Router, type RouterHost } from './router.ts';
import { aggregate, renderStatus, type StatusBarUpdate } from './status.ts';

// Why a short cache: every open lists the workspaces, and a few seconds old is fresh enough.
const WORKSPACE_LIST_TTL_MS = 10_000;

let router: Router | null = null;

export default async function activate(orca: OrcaWorkerApi): Promise<void> {
  let workspaces: { rows: Promise<WorkspaceRow[]>; at: number } | null = null;
  const status = (update: StatusBarUpdate): void => {
    orca.host
      .call('statusBar.update', update)
      .catch((error: unknown) => orca.log(`status bar update failed: ${String(error)}`));
  };
  const host: RouterHost = {
    listWorkspaces(options) {
      if (options?.fresh || !workspaces || Date.now() - workspaces.at > WORKSPACE_LIST_TTL_MS) {
        const rows = orca.host
          .call('workspace.list')
          .then(({ workspaces: list }) =>
            list.map((row): WorkspaceRow => ({
              id: row.id,
              name: row.name,
              branch: row.branch,
              path: row.path,
              hostId: row.hostId,
            }))
          );
        const cached = { rows, at: Date.now() };
        workspaces = cached;
        rows.catch(() => {
          if (workspaces === cached) {
            workspaces = null;
          }
        });
      }
      return workspaces.rows;
    },
    async openEditor(workspaceId, path) {
      await orca.host.call('editor.open', { workspaceId, path });
    },
    post(event, payload, options) {
      // Why the cast: the router posts the declared phpantom.* events, typed where they are built.
      orca.panels.post(event as 'phpantom.status', payload as never, options);
    },
    status,
    log: (message) => orca.log(message),
    async settings() {
      const values = await orca.settings.get();
      return {
        phpantomPath: typeof values.phpantomPath === 'string' ? values.phpantomPath.trim() : '',
        allowDownload: values.allowDownload !== false,
      };
    },
  };
  const active = new Router(host);
  router = active;

  orca.panels.handle('phpantom.open', (input, context) =>
    active.open(input, { panel: context.panel.id })
  );
  orca.panels.handle('phpantom.change', (input) => active.change(input));
  orca.panels.handle('phpantom.request', (input, context) => active.request(input, context.signal));
  orca.panels.handle('phpantom.close', (input) => active.close(input));
  orca.panels.handle('phpantom.navigate', (input) => active.navigate(input));
  orca.panels.handle('phpantom.peek', (input) => active.peek(input));
  orca.panels.handle('phpantom.ping', (input) => active.ping(input));
  orca.commands.register('phpantom.status', () => active.describe());
  orca.commands.register('phpantom.restart', () => active.restartAll());
  orca.settings.onDidChange(() => active.forgetBinary());

  await orca.host
    .call('statusBar.update', renderStatus(aggregate([])))
    .catch((error: unknown) => orca.log(`status bar update failed: ${String(error)}`));
}

export async function deactivate(): Promise<void> {
  const active = router;
  router = null;
  await active?.dispose();
}
