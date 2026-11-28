// The TextView that `bindDocument` drives, over a Monaco text model. No Monaco import, so Node can test it against a stand-in that follows Monaco's rules.
//
// Monaco keeps one line ending per model and rewrites any inserted text whose line endings are of another kind (pieceTreeTextBuffer.js), and it keeps a UTF-8 BOM out of `getValue()`.
// A raw splice of Orca's text can therefore cut a `\r\n` pair and leave an extra line.
// So an outside write is applied as Orca's whole new text: switch the model to the line ending Monaco would pick for it, then apply the smallest edit between texts that use that one line ending.
import { smallestEdit, type Splice } from './edits.ts';
import type { TextView } from './sync.ts';

type Eol = '\n' | '\r\n';
const BOM = '﻿';

/** The parts of a Monaco text model this needs; offsets never count the BOM. */
interface ModelPort {
  /** `model.getValue()`: the text without the BOM, in the model's line ending. */
  getText: () => string;
  getEol: () => Eol;
  /** `model.setValue()`: a fresh text and a fresh undo history. */
  setText: (text: string) => void;
  /** `model.pushEOL()`: rewrites every line ending, as an undoable edit. */
  setEol: (eol: Eol) => void;
  /** `model.pushEditOperations()` over the range between two offsets. */
  replace: (start: number, end: number, text: string) => void;
  pushStackElement: () => void;
  onDidChangeContent: (listener: () => void) => { dispose: () => void };
}

type ModelView = TextView & {
  /** Puts the first document in without sending it back and without an undo step to empty it. */
  load: (initial: string) => void;
};

/** The line ending Monaco picks for a whole text: CRLF when more than half the line breaks have a `\r`. */
function monacoEol(text: string, fallback: Eol): Eol {
  let breaks = 0;
  let withCr = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 13) {
      breaks += 1;
      withCr += 1;
      if (text.charCodeAt(i + 1) === 10) i += 1;
    } else if (code === 10) {
      breaks += 1;
    }
  }
  if (breaks === 0) return fallback;
  return withCr > breaks / 2 ? '\r\n' : '\n';
}

const normalizeEol = (text: string, eol: Eol): string => text.replaceAll(/\r\n|\r|\n/g, eol);

function modelView(port: ModelPort): ModelView {
  let bom = '';
  // True while text from Orca goes in, so it is not taken for typing and sent back.
  let applying = false;
  const quietly = (apply: () => void): void => {
    applying = true;
    try {
      apply();
    } finally {
      applying = false;
    }
  };
  const view: ModelView = {
    applyOutside(splice: Splice) {
      const current = view.getValue();
      const next = current.slice(0, splice.start) + splice.text + current.slice(splice.end);
      const nextBom = next.startsWith(BOM) ? BOM : '';
      const body = next.slice(nextBom.length);
      const eol = monacoEol(body, port.getEol());
      const target = normalizeEol(body, eol);
      quietly(() => {
        // Why: its own undo step, so Cmd+Z never takes the person's typing and the agent's write together.
        port.pushStackElement();
        try {
          if (eol !== port.getEol()) {
            port.setEol(eol);
            // Why: a step of its own.
            // Monaco records the edit's offsets against the new line endings but redoes a step's edits before its line-ending change, so sharing one corrupts redo.
            port.pushStackElement();
          }
          const edit = smallestEdit(port.getText(), target);
          if (edit) {
            port.replace(edit.start, edit.end, edit.text);
          }
          if (port.getText() !== target) {
            port.replace(0, port.getText().length, target);
          }
        } finally {
          port.pushStackElement();
        }
      });
      bom = nextBom;
    },
    getValue: () => bom + port.getText(),
    load(initial) {
      bom = initial.startsWith(BOM) ? BOM : '';
      quietly(() => {
        port.setText(initial.slice(bom.length));
      });
    },
    onUserChange: (listener) =>
      port.onDidChangeContent(() => {
        if (!applying) {
          listener();
        }
      }),
  };
  return view;
}

export { monacoEol, normalizeEol, modelView };
export type { Eol, ModelPort, ModelView };
