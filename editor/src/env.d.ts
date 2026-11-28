declare global {
  interface Window {
    /** Set by each page before the bundle loads. */
    __PHPANTOM_LANGUAGE__?: 'php' | 'blade';
  }
}

// oxlint-disable-next-line unicorn/require-module-specifiers -- keeps this file a module so `declare global` is valid
export {};
