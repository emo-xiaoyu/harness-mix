import { describe, expect, it } from "vitest";

import {
  HARNESS_HANDOFF_NOTE_MAX_LENGTH,
  rendererHarnessHandoffMessages,
} from "../src/renderer-harness-handoff.js";

describe("Renderer Harness handoff", () => {
  it("uses a bounded note compatible with the Host switch contract", () => {
    expect(HARNESS_HANDOFF_NOTE_MAX_LENGTH).toBe(2000);
  });

  it("explains that the task and working tree stay in place", () => {
    const messages = rendererHarnessHandoffMessages("zh-CN");
    expect(messages.title).toBe("接力当前任务");
    expect(messages.description).toMatch(/任务窗口.*对话记录.*文件现场/);
    expect(messages.context).toMatch(/近期对话.*最新方案.*计划.*变更文件/);
    expect(messages.running).toMatch(/先停止或等待完成/);
  });
});
