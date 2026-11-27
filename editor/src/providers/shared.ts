// Adapted from actus7/orca-autocomplete editor/src/lsp.ts @ da5a680 (MIT). See THIRD_PARTY_NOTICES.md.
// What the language feature providers share: their types, the server name they show, and the cancellation and disposal helpers.
import { isRecord } from '../../../src/utils/json.ts';
import type { monaco } from '../monaco.ts';

interface Disposable {
  dispose: () => void;
}
type Model = monaco.editor.ITextModel;

const SERVER_NAME = 'PHPantom';

/** Monaco's cancellation token as an AbortSignal for one request. */
async function withSignal<T>(
  token: monaco.CancellationToken,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  if (token.isCancellationRequested) controller.abort();
  const listener = token.onCancellationRequested(() => {
    controller.abort();
  });
  try {
    return await run(controller.signal);
  } finally {
    listener.dispose();
  }
}

/** The error Monaco takes as a cancellation: a resolve that ends this way is asked again later. */
function canceled(): Error {
  const error = new Error('Canceled');
  error.name = 'Canceled';
  return error;
}

/** The server's capability at `path`, or undefined where the path leaves its objects. */
function capability(capabilities: Record<string, unknown>, ...path: string[]): unknown {
  let value: unknown = capabilities;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return value;
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** `value` when it is a list of strings (trigger characters, code action kinds), else undefined. */
const stringList = (value: unknown): string[] | undefined =>
  isStringList(value) ? value : undefined;

function disposeAll(list: Disposable[]): Disposable {
  return {
    dispose() {
      for (const item of list.splice(0)) item.dispose();
    },
  };
}

export { SERVER_NAME, canceled, capability, disposeAll, isRecord, stringList, withSignal };
export type { Disposable, Model };
