// Monaco with only what this plugin uses: the editor, its features, PHP, HTML and Blade.
import * as monaco from 'monaco-editor/editor';
import 'monaco-editor/features/register.all';
// Why: register.all brings only the viewport (range) semantic tokens feature in 0.57; PHPantom offers full only.
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens';
import 'monaco-editor/languages/definitions/php/register';
import 'monaco-editor/languages/definitions/html/register';
import { conf, language } from 'monaco-editor/languages/definitions/html/html';

import { bladeGrammar } from './blade.ts';

// Monaco's background worker sits beside the bundle in editor/dist.
globalThis.MonacoEnvironment = {
  getWorker: () => new Worker(new URL('./editor.worker.js', import.meta.url), { type: 'module' }),
};

monaco.languages.register({ id: 'blade', extensions: ['.blade.php'], aliases: ['Blade', 'blade'] });
const blade = bladeGrammar({ conf, language });
monaco.languages.setLanguageConfiguration('blade', blade.conf);
monaco.languages.setMonarchTokensProvider('blade', blade.language);

export { monaco };
