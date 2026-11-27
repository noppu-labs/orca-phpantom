export {}

declare global {
  interface Window {
    /** Set by each page before the bundle loads. */
    __PHPANTOM_LANGUAGE__?: 'php' | 'blade'
  }
}
