export const TRANSCRIPT_ITEM_SELECTOR = "[data-local-conversation-item-target-ids]";
export const TRANSCRIPT_ITEM_IDS_ATTRIBUTE = "data-local-conversation-item-target-ids";
export const TRANSCRIPT_TEXT_BODY_SELECTOR = '[data-testid="exec-shell-body"]';

export interface RendererTranscriptContractInspection {
  /** Rendered Turn containers — separates an empty Thread from a vanished contract. */
  turnCount: number;
  /** Transcript nodes that advertise which Host Item ids they render. */
  itemNodeCount: number;
  /** Host Item ids referenced by those nodes in total. */
  identifiedItemCount: number;
  /** Command Execution text bodies — the one transcript surface keeping text. */
  textBodyCount: number;
  /** Item nodes that carry at least one such text body. */
  textBodyOwnerCount: number;
}

function publishedIdCount(node: Element): number {
  const raw = node.getAttribute(TRANSCRIPT_ITEM_IDS_ATTRIBUTE);
  if (!raw) return 0;
  return raw.split(/\s+/).filter(Boolean).length;
}

/**
 * Codex only renders transcript text on its Command Execution lane, and that
 * is exactly the lane harnessmix projects external Harness Reasoning through.
 * These bounded structural counters let a Desktop update that drops the lane,
 * or stops publishing Item ids, get caught instead of silently erasing the
 * projected text.
 */
export function inspectRendererTranscriptContract(
  root: ParentNode = document,
): RendererTranscriptContractInspection {
  const itemNodes = [...root.querySelectorAll(TRANSCRIPT_ITEM_SELECTOR)];
  let identifiedItemCount = 0;
  let textBodyOwnerCount = 0;
  for (const node of itemNodes) {
    identifiedItemCount += publishedIdCount(node);
    if (node.querySelector(TRANSCRIPT_TEXT_BODY_SELECTOR)) textBodyOwnerCount += 1;
  }
  return {
    turnCount: root.querySelectorAll("[data-turn-key]").length,
    itemNodeCount: itemNodes.length,
    identifiedItemCount,
    textBodyCount: root.querySelectorAll(TRANSCRIPT_TEXT_BODY_SELECTOR).length,
    textBodyOwnerCount,
  };
}
