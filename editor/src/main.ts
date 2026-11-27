// Adapted from actus7/orca-autocomplete editor/src/main.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// The bundle's entry: start the editor, or say on the page why it could not start.
import { attachLanguageServer } from './attach.ts';
import { startEditor } from './editor.ts';

startEditor().then(
  (ctx) => {
    // Why its own catch: without PHPantom the editor still edits, so a failure here must not blank the tab.
    try {
      attachLanguageServer(ctx);
    } catch (error) {
      // oxlint-disable-next-line eslint/no-console -- last resort for a failed attach: Orca copies a frame's console errors into orca plugin logs
      console.error('PHPantom could not attach', error);
    }
  },
  (error: unknown) => {
    // Orca copies frame errors into the plugin's log; also say it on screen so the tab is not blank.
    // oxlint-disable-next-line eslint/no-console -- last resort for an editor that could not start: Orca copies a frame's console errors into orca plugin logs
    console.error(error);
    const failure = document.createElement('div');
    failure.className = 'start-failed';
    failure.setAttribute('role', 'alert');
    const title = document.createElement('strong');
    title.textContent = 'The PHPantom editor could not start.';
    const detail = document.createElement('span');
    detail.textContent = error instanceof Error ? error.message : String(error);
    failure.append(title, detail);
    document.querySelector('#root')?.replaceChildren(failure);
  }
);
