// Adapted from actus7/orca-autocomplete editor/src/monaco-modules.d.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// A script file on purpose (no top-level import or export), so this is a module declaration.
// Monaco ships no declarations for its language definitions; this one exports HTML's grammar.
declare module 'monaco-editor/languages/definitions/html/html' {
  import type { languages } from 'monaco-editor/editor'
  export const conf: languages.LanguageConfiguration
  export const language: languages.IMonarchLanguage
}
