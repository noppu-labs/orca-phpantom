// Orca's frame API as a BridgeHost. No Monaco here, so its save hook can be tested against Orca's mock host.
import type { PluginRequestArgs } from 'orca';

import type { BridgeHost, WorkspaceContext } from './bridge.ts';

function context(
  value: { workspaceId?: string; branch: string; displayName: string } | null
): WorkspaceContext | null {
  return value
    ? {
        workspaceId: value.workspaceId ?? null,
        branch: value.branch,
        displayName: value.displayName,
      }
    : null;
}

export function frameHost(): BridgeHost {
  return {
    request: async (name, input, options) =>
      // Why the cast: the declared overload takes its arguments as a tuple.
      orca.plugin.request(name, ...([input, options] as unknown as PluginRequestArgs<typeof name>)),
    on: (event, handler) => orca.plugin.on(event as 'phpantom.diagnostics', handler),
    readContext: async () => context(await orca.host.call('workspace.readContext', {})),
    // `orca.on` subscribes through `events.subscribe` itself, and a new subscriber hears the current context first.
    onWorkspaceChanged: (listener) =>
      orca.on('workspace.changed', (payload) => listener(context(payload.context))),
    onFirstInput(listener) {
      // Capture on window: Monaco stops some events, and editor.focus() at start is not input.
      const handler = (): void => listener();
      window.addEventListener('pointerdown', handler, true);
      window.addEventListener('keydown', handler, true);
      return {
        dispose() {
          window.removeEventListener('pointerdown', handler, true);
          window.removeEventListener('keydown', handler, true);
        },
      };
    },
    onSaved(listener) {
      // Orca waits for a promise a handler returns before saving; this one returns nothing, so it never delays a save.
      return orca.on('editor.flush', () => {
        listener();
      });
    },
    onSettingsChanged: (listener) => orca.settings.onDidChange(() => listener()),
    onVisible(listener) {
      const handler = (): void => {
        if (document.visibilityState === 'visible') listener();
      };
      document.addEventListener('visibilitychange', handler);
      return { dispose: () => document.removeEventListener('visibilitychange', handler) };
    },
  };
}
