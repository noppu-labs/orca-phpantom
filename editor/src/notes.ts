// Short notes over the editor, one per key: showing a key again replaces its text.

const notes = new Map<string, { element: HTMLElement; text: HTMLElement }>();

function container(): HTMLElement {
  let element = document.querySelector<HTMLElement>('#phpantom-notes');
  if (!element) {
    element = document.createElement('div');
    element.id = 'phpantom-notes';
    element.className = 'phpantom-notes';
    document.body.append(element);
  }
  return element;
}

function showNote(kind: 'info' | 'warning', text: string, key: string): void {
  let note = notes.get(key);
  if (!note) {
    const element = document.createElement('div');
    const body = document.createElement('span');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'phpantom-note-close';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => {
      clearNote(key);
    });
    element.append(body, close);
    container().append(element);
    note = { element, text: body };
    notes.set(key, note);
  }
  note.element.className = `phpantom-note phpantom-note-${kind}`;
  note.element.setAttribute('role', kind === 'warning' ? 'alert' : 'status');
  note.text.textContent = text;
}

function clearNote(key: string): void {
  notes.get(key)?.element.remove();
  notes.delete(key);
}

export { showNote, clearNote };
