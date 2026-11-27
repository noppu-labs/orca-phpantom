declare global {
  /** Set by each page before the bundle loads. */
  // oxlint-disable-next-line eslint/no-underscore-dangle -- the entry pages (editor/pages/*.html) set this global under this name
  var __PHPANTOM_LANGUAGE__: 'php' | 'blade' | undefined;
}

// oxlint-disable-next-line unicorn/require-module-specifiers -- keeps this file a module so `declare global` is valid
export {};
