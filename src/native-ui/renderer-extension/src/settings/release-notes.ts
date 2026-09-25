// Minimal markdown renderer for release notes shown in the settings dialog.
// It supports the small subset used by Harness Mix changelogs: ATX headings,
// fenced code, blockquotes, lists (with indented translation continuations),
// thematic breaks, paragraphs, and inline code/bold/links.

const HEADING_PATTERN = /^(#{1,6})[ \t]+(.+?)\s*$/u;
const BLOCKQUOTE_PATTERN = /^>[ \t]?(.*?)\s*$/u;
const UNORDERED_ITEM_PATTERN = /^[-*][ \t]+(.+?)\s*$/u;
const CONTINUATION_PATTERN = /^[ \t]+(.+?)\s*$/u;
const ORDERED_ITEM_PATTERN = /^\d+[.)][ \t]+(.+?)\s*$/u;
const FENCE_PATTERN = /^```([\w+-]*)\s*$/u;
const THEMATIC_BREAK_PATTERN = /^(?:---|___|\*\*\*)[ \t]*$/u;
const INLINE_PATTERN = /(`+)((?:(?!\1).)+)\1|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/gu;

type ReleaseNotesDocument = Pick<Document, "createElement">;

export function createReleaseNotesElement(
  document: ReleaseNotesDocument,
  markdown: string,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "settings-update-notes";
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  let cursor = 0;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? "";
    if (line.trim().length === 0) {
      cursor += 1;
      continue;
    }
    const fence = FENCE_PATTERN.exec(line);
    if (fence) {
      cursor = takeFencedCode(document, container, lines, cursor, fence[1] ?? "");
      continue;
    }
    const heading = HEADING_PATTERN.exec(line);
    if (heading?.[1] && heading[2]) {
      const tag = `h${heading[1].length}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
      const element = document.createElement(tag);
      appendInlineRuns(document, element, heading[2]);
      container.append(element);
      cursor += 1;
      continue;
    }
    if (BLOCKQUOTE_PATTERN.test(line)) {
      cursor = takeBlockquote(document, container, lines, cursor);
      continue;
    }
    if (THEMATIC_BREAK_PATTERN.test(line)) {
      container.append(document.createElement("hr"));
      cursor += 1;
      continue;
    }
    if (UNORDERED_ITEM_PATTERN.test(line)) {
      cursor = takeList(document, container, lines, cursor, "ul", UNORDERED_ITEM_PATTERN);
      continue;
    }
    if (ORDERED_ITEM_PATTERN.test(line)) {
      cursor = takeList(document, container, lines, cursor, "ol", ORDERED_ITEM_PATTERN);
      continue;
    }
    cursor = takeParagraph(document, container, lines, cursor);
  }
  return container;
}

function takeFencedCode(
  document: ReleaseNotesDocument,
  container: HTMLElement,
  lines: readonly string[],
  start: number,
  language: string,
): number {
  const body: string[] = [];
  let cursor = start + 1;
  while (cursor < lines.length && !FENCE_PATTERN.test(lines[cursor] ?? "")) {
    body.push(lines[cursor] ?? "");
    cursor += 1;
  }
  if (cursor < lines.length) cursor += 1;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  if (language.length > 0) code.className = `language-${language}`;
  code.textContent = body.join("\n");
  pre.append(code);
  container.append(pre);
  return cursor;
}

function takeBlockquote(
  document: ReleaseNotesDocument,
  container: HTMLElement,
  lines: readonly string[],
  start: number,
): number {
  const quoted: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const match = BLOCKQUOTE_PATTERN.exec(lines[cursor] ?? "");
    if (!match) break;
    quoted.push(match[1] ?? "");
    cursor += 1;
  }
  const blockquote = document.createElement("blockquote");
  const paragraph = document.createElement("p");
  appendInlineRuns(document, paragraph, quoted.join(" ").trim());
  blockquote.append(paragraph);
  container.append(blockquote);
  return cursor;
}

function takeList(
  document: ReleaseNotesDocument,
  container: HTMLElement,
  lines: readonly string[],
  start: number,
  tag: "ul" | "ol",
  itemPattern: RegExp,
): number {
  const list = document.createElement(tag);
  let cursor = start;
  while (cursor < lines.length) {
    const item = itemPattern.exec(lines[cursor] ?? "");
    if (!item?.[1]) break;
    const entry = document.createElement("li");
    appendInlineRuns(document, entry, item[1]);
    cursor += 1;

    const continuationLines: string[] = [];
    while (cursor < lines.length) {
      const continuation = CONTINUATION_PATTERN.exec(lines[cursor] ?? "");
      if (!continuation?.[1]) break;
      continuationLines.push(continuation[1]);
      cursor += 1;
    }
    if (continuationLines.length > 0) {
      // Indented lines under a bullet carry the translated copy of that item.
      const continuation = document.createElement("span");
      continuation.className = "release-note-translation";
      appendInlineRuns(document, continuation, continuationLines.join(" "));
      entry.append(continuation);
    }
    list.append(entry);
  }
  container.append(list);
  return cursor;
}

function takeParagraph(
  document: ReleaseNotesDocument,
  container: HTMLElement,
  lines: readonly string[],
  start: number,
): number {
  const collected: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const current = lines[cursor] ?? "";
    if (
      current.trim().length === 0 ||
      FENCE_PATTERN.test(current) ||
      HEADING_PATTERN.test(current) ||
      BLOCKQUOTE_PATTERN.test(current) ||
      THEMATIC_BREAK_PATTERN.test(current) ||
      UNORDERED_ITEM_PATTERN.test(current) ||
      ORDERED_ITEM_PATTERN.test(current)
    ) {
      break;
    }
    collected.push(current.trim());
    cursor += 1;
  }
  const paragraph = document.createElement("p");
  collected.forEach((line, lineIndex) => {
    appendInlineRuns(document, paragraph, line);
    if (lineIndex < collected.length - 1) paragraph.append(document.createElement("br"));
  });
  container.append(paragraph);
  return cursor;
}

function appendInlineRuns(document: ReleaseNotesDocument, parent: HTMLElement, text: string): void {
  let consumed = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const at = match.index ?? 0;
    if (at > consumed) parent.append(text.slice(consumed, at));
    if (match[2] !== undefined) {
      const code = document.createElement("code");
      code.textContent = match[2];
      parent.append(code);
    } else if (match[3] !== undefined) {
      const strong = document.createElement("strong");
      strong.textContent = match[3];
      parent.append(strong);
    } else {
      const href = match[5] ?? "";
      if (!isSafeLink(href)) {
        parent.append(match[4] ?? "");
      } else {
        const link = document.createElement("a");
        link.textContent = match[4] ?? "";
        link.setAttribute("href", href);
        link.setAttribute("target", "_blank");
        link.setAttribute("rel", "noopener noreferrer");
        parent.append(link);
      }
    }
    consumed = at + match[0].length;
  }
  if (consumed < text.length) parent.append(text.slice(consumed));
}

function isSafeLink(href: string): boolean {
  try {
    const url = new URL(href, "https://harnessmix.invalid");
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
