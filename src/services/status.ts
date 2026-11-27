export interface ServerState {
  phase: 'downloading' | 'starting' | 'indexing' | 'ready' | 'error';
  percent?: number;
  message?: string;
}

export interface StatusState {
  phase: 'idle' | ServerState['phase'];
  percent?: number;
  message?: string;
  version?: string;
  source?: 'setting' | 'path' | 'cache' | 'download';
}

// A literal union rather than `string`, so the update can go straight to `statusBar.update`.
export interface StatusBarUpdate {
  id: 'phpantom';
  text: string;
  icon: 'code' | 'check' | 'error' | 'download' | 'refresh';
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  tooltip: string;
}

const URGENCY: ServerState['phase'][] = ['error', 'downloading', 'starting', 'indexing', 'ready'];

const SOURCE_WORDS: Record<NonNullable<StatusState['source']>, string> = {
  setting: 'from settings',
  path: 'from PATH',
  cache: 'cached',
  download: 'downloaded',
};

/** Folds every running server into one state: the most urgent phase wins. */
export function aggregate(states: ServerState[]): StatusState {
  for (const phase of URGENCY) {
    const matching = states.filter((s) => s.phase === phase);
    if (matching.length === 0) {
      continue;
    }
    const state: StatusState = { phase };
    if (phase === 'indexing') {
      const percents = matching.flatMap((s) => (s.percent === undefined ? [] : [s.percent]));
      if (percents.length > 0) {
        state.percent = Math.min(...percents);
      }
    }
    if (phase === 'error') {
      const message = matching.find((s) => s.message !== undefined)?.message;
      if (message !== undefined) {
        state.message = message;
      }
    }
    return state;
  }
  return { phase: 'idle' };
}

export function renderStatus(state: StatusState): StatusBarUpdate {
  switch (state.phase) {
    case 'idle': {
      return {
        id: 'phpantom',
        text: 'PHPantom',
        icon: 'code',
        tone: 'neutral',
        tooltip: 'PHPantom: no PHP files open',
      };
    }
    case 'error': {
      return {
        id: 'phpantom',
        text: 'PHPantom: error',
        icon: 'error',
        tone: 'danger',
        tooltip: `PHPantom: ${state.message ?? 'error'}`,
      };
    }
    case 'downloading': {
      return {
        id: 'phpantom',
        text: 'PHPantom: downloading',
        icon: 'download',
        tone: 'accent',
        tooltip: 'PHPantom: downloading the language server',
      };
    }
    case 'starting': {
      return {
        id: 'phpantom',
        text: 'PHPantom: starting',
        icon: 'refresh',
        tone: 'neutral',
        tooltip: 'PHPantom: starting the language server',
      };
    }
    case 'indexing': {
      const progress = state.percent === undefined ? '' : ` ${state.percent}%`;
      return {
        id: 'phpantom',
        text: `PHPantom: indexing${progress}`,
        icon: 'refresh',
        tone: 'neutral',
        tooltip: `PHPantom: indexing the project${progress}`,
      };
    }
    case 'ready': {
      const version = state.version === undefined ? '' : ` ${state.version}`;
      const source = state.source === undefined ? '' : ` (${SOURCE_WORDS[state.source]})`;
      return {
        id: 'phpantom',
        text: 'PHPantom',
        icon: 'check',
        tone: 'neutral',
        tooltip: `PHPantom${version}${source}, ready`,
      };
    }
  }
}
