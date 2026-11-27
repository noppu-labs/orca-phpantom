// Monaco with only what this plugin uses: the editor, its features, PHP, HTML and Blade.
// oxlint-disable-next-line import/no-namespace, oxc/no-barrel-file, unicorn/prefer-export-from -- the one module that imports monaco-editor: it registers Blade with the namespace and re-exports it whole as Monaco's API for the rest of editor/src
import * as monaco from 'monaco-editor/editor';
// oxlint-disable-next-line import/no-unassigned-import -- registers Monaco's editor features as it loads
import 'monaco-editor/features/register.all';
// Why: register.all brings only the viewport (range) semantic tokens feature in 0.57; PHPantom offers full only.
// oxlint-disable-next-line import/no-unassigned-import -- registers the full-document semantic tokens feature as it loads
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens';
// oxlint-disable-next-line import/no-unassigned-import -- registers the PHP language with Monaco as it loads
import 'monaco-editor/languages/definitions/php/register';
// oxlint-disable-next-line import/no-unassigned-import -- registers the HTML language with Monaco as it loads
import 'monaco-editor/languages/definitions/html/register';
import { conf, language } from 'monaco-editor/languages/definitions/html/html';

import { bladeGrammar } from './blade.ts';

// Monaco's background worker sits beside the bundle in editor/dist.
globalThis.MonacoEnvironment = {
  // oxlint-disable-next-line unicorn/relative-url-style -- esbuild and Orca's editor check read this literal
  getWorker: () => new Worker(new URL('./editor.worker.js', import.meta.url), { type: 'module' }),
};

monaco.languages.register({ aliases: ['Blade', 'blade'], extensions: ['.blade.php'], id: 'blade' });
const blade = bladeGrammar({ conf, language });
monaco.languages.setLanguageConfiguration('blade', blade.conf);
monaco.languages.setMonarchTokensProvider('blade', blade.language);

export { monaco };
