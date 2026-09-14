import { describe, expect, it } from "vitest";
import { CHATGPT_CONTEXT_MAX_LENGTH, buildChatGptContextDraft, isChatGptQuickChatEditor, redactChatGptContextText, sanitizeChatGptSourceUrl } from "../src/renderer-chatgpt-context.js";

describe("ChatGPT context package", () => {
  it("marks imported text as untrusted context", () => {
    const draft = buildChatGptContextDraft({ title: "架构讨论", sourceUrl: "https://chatgpt.com/c/example?utm_source=secret#turn", mode: "loaded-messages", messages: [{ role: "user", text: "给一个迁移方案" }, { role: "assistant", text: "先建立共享契约" }], truncated: false });
    expect(draft).toContain("不可信历史资料"); expect(draft).toContain("不恢复原聊天"); expect(draft).toContain("User: 给一个迁移方案"); expect(draft).toContain("Assistant: 先建立共享契约"); expect(draft).toContain("https://chatgpt.com/c/example"); expect(draft).not.toContain("utm_source");
  });
  it("redacts credentials and caps the package", () => {
    expect(redactChatGptContextText("Authorization: Bearer abcdefghijklmnopqrstuvwxyz sk-abcdefghijklmnopqrstuvwxyz123456")).not.toContain("abcdefghijklmnopqrstuvwxyz");
    const draft = buildChatGptContextDraft({ title: "大段聊天", mode: "selection", messages: [{ role: "user", text: "x".repeat(CHATGPT_CONTEXT_MAX_LENGTH * 2) }], truncated: true });
    expect(draft.length).toBeLessThanOrEqual(CHATGPT_CONTEXT_MAX_LENGTH); expect(draft).toContain("已截断");
  });
  it("accepts only sanitized HTTPS ChatGPT links", () => {
    expect(sanitizeChatGptSourceUrl("https://chatgpt.com/c/abc?token=nope#part")).toBe("https://chatgpt.com/c/abc");
    expect(sanitizeChatGptSourceUrl("http://chatgpt.com/c/abc")).toBeUndefined(); expect(sanitizeChatGptSourceUrl("https://example.com/c/abc")).toBeUndefined();
  });
  it("ignores partial DOM fixtures that are not browser Elements", () => {
    expect(isChatGptQuickChatEditor({} as Element)).toBe(false);
  });
});
