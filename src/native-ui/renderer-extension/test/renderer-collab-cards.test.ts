import { describe, expect, it } from "vitest";
import {
  parseCollabPayload,
  formatDiffHtml,
  installCollabCards,
} from "../src/renderer-collab-cards.js";

describe("renderer-collab-cards", () => {
  it("parses collaboration payloads correctly", () => {
    expect(parseCollabPayload("")).toBeNull();
    expect(parseCollabPayload("hello world")).toBeNull();

    const payload = {
      task_id: "task-123",
      child_thread_id: "thread-child-456",
      agent_type: "pi",
      status: "completed",
    };
    const text = `Agent 协作 · Pi\n${JSON.stringify(payload)}`;
    const parsed = parseCollabPayload(text);
    expect(parsed).not.toBeNull();
    expect(parsed?.task_id).toBe("task-123");
    expect(parsed?.child_thread_id).toBe("thread-child-456");
    expect(parsed?.agent_type).toBe("pi");
  });

  it("formats diff HTML with color coding", () => {
    expect(formatDiffHtml("")).toContain("暂无文件改动");

    const diff = `--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n-old line\n+new line\n context`;
    const html = formatDiffHtml(diff);
    expect(html).toContain("+new line");
    expect(html).toContain("-old line");
    expect(html).toContain("#22c55e1a");
    expect(html).toContain("#ef44441a");
  });

  it("handles environment safely when document is not in global scope", () => {
    const control = installCollabCards();
    expect(typeof control.scan).toBe("function");
    expect(typeof control.dispose).toBe("function");
    control.scan();
    control.dispose();
  });
});
