interface ServerState {
  phase: 'downloading' | 'starting' | 'indexing' | 'ready' | 'error';
  percent?: number;
  message?: string;
}

interface StatusState {
  phase: 'idle' | ServerState['phase'];
  percent?: number;
  message?: string;
  version?: string;
  source?: 'setting' | 'path' | 'cache' | 'download';
}

// A literal union rather than `string`, so the update can go straight to `statusBar.update`.
interface StatusBarUpdate {
  id: 'phpantom';
  text: string;
  icon: 'code' | 'check' | 'error' | 'download' | 'refresh';
  tone: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
  tooltip: string;
}

const URGENCY: ServerState['phase'][] = ['error', 'downloading', 'starting', 'indexing', 'ready'];

const SOURCE_WORDS: Record<NonNullable<StatusState['source']>, string> = {
  cache: 'cached',
  download: 'downloaded',
  path: 'from PATH',
  setting: 'from settings',
};

/** Folds every running server into one state: the most urgent phase wins. */
function aggregate(states: ServerState[]): StatusState {
  for (const phase of URGENCY) {
    const matching = states.filter((server) => server.phase === phase);
    if (matching.length === 0) {
      continue;
    }
    const state: StatusState = { phase };
    if (phase === 'indexing') {
      const percents = matching.flatMap((server) =>
        server.percent === undefined ? [] : [server.percent]
      );
      if (percents.length > 0) {
        state.percent = Math.min(...percents);
      }
    }
    if (phase === 'error') {
      const message = matching.find((server) => server.message !== undefined)?.message;
      if (message !== undefined) {
        state.message = message;
      }
    }
    return state;
  }
  return { phase: 'idle' };
}

function renderStatus(state: StatusState): StatusBarUpdate {
  switch (state.phase) {
    case 'idle': {
      return {
        icon: 'code',
        id: 'phpantom',
        text: 'PHPantom',
        tone: 'neutral',
        tooltip: 'PHPantom: no PHP files open',
      };
    }
    case 'error': {
      return {
        icon: 'error',
        id: 'phpantom',
        text: 'PHPantom: error',
        tone: 'danger',
        tooltip: `PHPantom: ${state.message ?? 'error'}`,
      };
    }
    case 'downloading': {
      return {
        icon: 'download',
        id: 'phpantom',
        text: 'PHPantom: downloading',
        tone: 'accent',
        tooltip: 'PHPantom: downloading the language server',
      };
    }
    case 'starting': {
      return {
        icon: 'refresh',
        id: 'phpantom',
        text: 'PHPantom: starting',
        tone: 'neutral',
        tooltip: 'PHPantom: starting the language server',
      };
    }
    case 'indexing': {
      const progress = state.percent === undefined ? '' : ` ${state.percent}%`;
      return {
        icon: 'refresh',
        id: 'phpantom',
        text: `PHPantom: indexing${progress}`,
        tone: 'neutral',
        tooltip: `PHPantom: indexing the project${progress}`,
      };
    }
    case 'ready': {
      const version = state.version === undefined ? '' : ` ${state.version}`;
      const source = state.source === undefined ? '' : ` (${SOURCE_WORDS[state.source]})`;
      return {
        icon: 'check',
        id: 'phpantom',
        text: 'PHPantom',
        tone: 'neutral',
        tooltip: `PHPantom${version}${source}, ready`,
      };
    }
  }
}

export { aggregate, renderStatus };
export type { ServerState, StatusState, StatusBarUpdate };
