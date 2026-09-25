import type { HarnessCommandDescriptor } from "@harnessmix/shared-contracts";

function composeInputEvent(editor: HTMLElement, inserted: string): Event {
  const win = editor.ownerDocument.defaultView;
  if (win?.InputEvent) {
    return new win.InputEvent("input", {
      bubbles: true,
      composed: true,
      data: inserted,
      inputType: "insertText",
    });
  }
  return new (win?.Event ?? Event)("input", { bubbles: true, composed: true });
}

function nativeTextareaValueSetter(win: Window): ((value: string) => void) | undefined {
  const textareaConstructor = (win as Window & typeof globalThis).HTMLTextAreaElement;
  return Object.getOwnPropertyDescriptor(textareaConstructor.prototype, "value")?.set;
}

function insertIntoTextarea(editor: HTMLElement, prefix: string): boolean {
  const win = editor.ownerDocument.defaultView;
  const textareaConstructor = win && (win as Window & typeof globalThis).HTMLTextAreaElement;
  if (!win || !textareaConstructor || !(editor instanceof textareaConstructor)) return false;
  const assignValue = nativeTextareaValueSetter(win);
  if (!assignValue) return false;
  const { selectionStart, selectionEnd } = editor;
  assignValue.call(editor, prefix + editor.value);
  editor.dispatchEvent(composeInputEvent(editor, prefix));
  editor.focus({ preventScroll: true });
  if (selectionStart !== null && selectionEnd !== null) {
    editor.setSelectionRange(selectionStart + prefix.length, selectionEnd + prefix.length);
  }
  return true;
}

function insertIntoContentEditable(editor: HTMLElement, prefix: string): boolean {
  if (editor.getAttribute("contenteditable") !== "true") return false;
  const doc = editor.ownerDocument;
  const selection = doc.getSelection();
  if (!selection || typeof doc.execCommand !== "function") return false;
  const caret = doc.createRange();
  caret.selectNodeContents(editor);
  caret.collapse(true);
  editor.focus({ preventScroll: true });
  selection.removeAllRanges();
  selection.addRange(caret);
  return doc.execCommand("insertText", false, prefix);
}

function insertIntoEditor(editor: HTMLElement, prefix: string): boolean {
  return insertIntoTextarea(editor, prefix) || insertIntoContentEditable(editor, prefix);
}

// Compact always defers to the native default; commands that take no argument do the same.
export function rendererHarnessCommandExecutesDirectly(command: HarnessCommandDescriptor): boolean {
  return command.invocation === "/compact" || command.argumentMode === "none";
}

export function routeRendererHarnessCommandSelection(
  editor: HTMLElement | null,
  command: HarnessCommandDescriptor,
  execute: () => void,
): boolean {
  if (rendererHarnessCommandExecutesDirectly(command)) {
    execute();
    return true;
  }
  return editor !== null && insertIntoEditor(editor, `${command.invocation} `);
}
