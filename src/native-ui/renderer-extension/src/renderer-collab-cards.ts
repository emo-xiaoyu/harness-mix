import { type HostThreadId, hostThreadIdSchema } from "@harnessmix/shared-contracts";
import { openRendererThread } from "./renderer-fork-control.js";
import { collaborationIcon } from "./collaboration-icon.js";

export interface CollabCardPayload {
  task_id?: string;
  parent_thread_id?: string;
  child_thread_id?: string;
  agent_type?: string;
  status?: string;
  display_status?: string;
  task?: string;
  result?: string;
  diff?: string;
  digest?: string;
  branch?: string;
  workspace?: { mode: string; cwd?: string; branch?: string };
  applied?: boolean;
}

export interface CollabCardOptions {
  openThread?: (threadId: HostThreadId) => Promise<void>;
  reviewWorkspace?: (threadId: string) => Promise<{ patch: string; digest: string; hasConflict?: boolean; conflictingFiles?: string[] }>;
  applyWorkspace?: (threadId: string, digest?: string) => Promise<{ patch: string; digest: string }>;
  continueCollab?: (threadId: string, taskId?: string) => Promise<unknown>;
}

/** Locate the embedded task JSON inside a transcript block, if any. */
export function parseCollabPayload(text: string): CollabCardPayload | null {
  if (!text || (!text.includes("child_thread_id") && !text.includes("task_id") && !text.includes("Agent 协作"))) {
    return null;
  }
  const match = /\{[\s\S]*?"task_id"[\s\S]*?\}/.exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    if (parsed && (parsed.task_id || parsed.child_thread_id)) return parsed as CollabCardPayload;
  } catch {}
  return null;
}

const DIFF_ROW_COLORS: Array<{ prefix: string; skipPrefix: string; background: string; color: string }> = [
  { prefix: "+", skipPrefix: "+++", background: "#22c55e1a", color: "#16a34a" },
  { prefix: "-", skipPrefix: "---", background: "#ef44441a", color: "#dc2626" },
];

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Render a unified diff as colored, escaped HTML rows. */
export function formatDiffHtml(diff: string): string {
  if (!diff) return '<div style="padding:8px;color:#888;font-size:12px">暂无文件改动</div>';
  const rows = diff.split(/\r?\n/).map((line) => {
    let background = "transparent";
    let color = "inherit";
    const rule = DIFF_ROW_COLORS.find(
      (entry) => line.startsWith(entry.prefix) && !line.startsWith(entry.skipPrefix),
    );
    if (rule) {
      background = rule.background;
      color = rule.color;
    } else if (line.startsWith("@@")) {
      background = "#8888881a";
      color = "#64748b";
    }
    return `<div style="background:${background};color:${color};padding:1px 8px;font-family:ui-monospace,monospace;white-space:pre">${escapeHtml(line) || " "}</div>`;
  });
  return `<div style="font-size:12px;line-height:1.45;max-height:360px;overflow:auto;border-radius:6px;border:1px solid #8883;background:#0001;margin-top:6px">${rows.join("")}</div>`;
}

function errorMessage(error: unknown): string {
  return (error as Error)?.message || String(error);
}

export function installCollabCards(options: CollabCardOptions = {}) {
  if (typeof document === "undefined") {
    return { scan: () => {}, dispose: () => {} };
  }
  let disposed = false;
  const alreadyEnhanced = new WeakSet<Element>();
  const jumpToThread = options.openThread ?? ((threadId: HostThreadId) => openRendererThread(threadId));

  const buildResumeControl = (payload: CollabCardPayload): HTMLElement | null => {
    // Interrupted delegation: one click resumes it (the Host injects a resume
    // turn into the lead thread as the user).
    if (payload.status !== "interrupted" || !payload.parent_thread_id || !options.continueCollab) {
      return null;
    }
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "harness-mix-collab-resume";
    resumeBtn.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;border:1px solid #c1702266;background:#c170221a;color:#c17022;font:inherit;cursor:pointer;font-size:12px;font-weight:500";
    resumeBtn.textContent = "▶ 恢复此任务";
    resumeBtn.title = "恢复中断的委派：主导者会收到恢复指令（不重放已完成副作用）";
    resumeBtn.addEventListener("click", async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      resumeBtn.disabled = true;
      try {
        await options.continueCollab!(payload.parent_thread_id!, payload.task_id);
        resumeBtn.textContent = "✓ 已下发恢复指令";
      } catch (err) {
        resumeBtn.disabled = false;
        resumeBtn.textContent = "▶ 恢复失败（重试）";
        resumeBtn.title = `恢复失败：${errorMessage(err)}`;
      }
    });
    return resumeBtn;
  };

  const buildJumpControl = (payload: CollabCardPayload, agent: string): HTMLElement | null => {
    if (!payload.child_thread_id) return null;
    const childId = payload.child_thread_id;
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "harness-mix-collab-jump";
    jumpBtn.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;border:1px solid #8884;background:#8881;color:inherit;font:inherit;cursor:pointer;font-size:12px";
    jumpBtn.innerHTML = `↗ 查看 <b>@${agent}</b> 会话`;
    jumpBtn.title = `切换定位至子任务会话 (${childId})`;
    jumpBtn.addEventListener("click", async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      const parsed = hostThreadIdSchema.safeParse(childId);
      if (parsed.success) {
        try {
          await jumpToThread(parsed.data);
        } catch (err) {
          console.warn("[CollabCard] Jump to thread failed:", err);
        }
      }
    });
    return jumpBtn;
  };

  const buildWorkspaceControls = (payload: CollabCardPayload): HTMLElement[] => {
    if (!payload.diff && payload.workspace?.mode !== "worktree") return [];
    const parts: HTMLElement[] = [];

    const diffContainer = document.createElement("div");
    diffContainer.className = "harness-mix-collab-diff-wrap";
    diffContainer.style.cssText = "width:100%;display:none;margin-top:6px";
    if (payload.diff) {
      diffContainer.innerHTML = formatDiffHtml(payload.diff);
    }

    const toggleDiffBtn = document.createElement("button");
    toggleDiffBtn.type = "button";
    toggleDiffBtn.className = "harness-mix-collab-diff-toggle";
    toggleDiffBtn.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;border:1px solid #8884;background:#8881;color:inherit;font:inherit;cursor:pointer;font-size:12px";
    toggleDiffBtn.textContent = "🔍 查看产物 Diff";
    toggleDiffBtn.addEventListener("click", async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      const isHidden = diffContainer.style.display === "none";
      if (isHidden && !diffContainer.innerHTML.trim() && payload.child_thread_id && options.reviewWorkspace) {
        toggleDiffBtn.textContent = "加载 Diff 中…";
        try {
          const review = await options.reviewWorkspace(payload.child_thread_id);
          diffContainer.innerHTML = formatDiffHtml(review.patch);
        } catch (err) {
          diffContainer.innerHTML = `<div style="padding:8px;color:#ef4444;font-size:12px">加载 Diff 失败: ${errorMessage(err)}</div>`;
        }
      }
      diffContainer.style.display = isHidden ? "block" : "none";
      toggleDiffBtn.textContent = isHidden ? "收起产物 Diff" : "🔍 查看产物 Diff";
    });
    parts.push(toggleDiffBtn, diffContainer);

    const canApply =
      payload.workspace?.mode === "worktree" && !payload.applied && options.applyWorkspace && payload.child_thread_id;
    if (canApply) {
      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "harness-mix-collab-apply";
      applyBtn.style.cssText = "display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;border:1px solid #16a34a88;background:#16a34a1a;color:#16a34a;font:inherit;cursor:pointer;font-size:12px;font-weight:500";
      applyBtn.textContent = "✓ 合并改动到主项目";
      applyBtn.title = "将该子任务的独立隔离分支改动应用到主工作区";
      applyBtn.addEventListener("click", async (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        applyBtn.disabled = true;
        applyBtn.textContent = "合并中…";
        try {
          await options.applyWorkspace!(payload.child_thread_id!, payload.digest);
          applyBtn.textContent = "✓ 已应用";
          applyBtn.style.border = "1px solid #8884";
          applyBtn.style.color = "#888";
          payload.applied = true;
        } catch (err) {
          applyBtn.disabled = false;
          applyBtn.textContent = "合并失败（重试）";
          alert(`合并失败：${errorMessage(err)}`);
        }
      });
      parts.push(applyBtn);
    }
    return parts;
  };

  const enhanceCard = (card: HTMLElement, payload: CollabCardPayload) => {
    if (alreadyEnhanced.has(card)) return;
    alreadyEnhanced.add(card);

    const strip = document.createElement("div");
    strip.className = "harness-mix-collab-actions";
    strip.style.cssText = "display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;padding-top:8px;border-top:1px solid #8882;font:13px system-ui";

    const agent = payload.agent_type || "agent";
    strip.append(collaborationIcon(agent, agent, 18));

    const resumeControl = buildResumeControl(payload);
    if (resumeControl) strip.append(resumeControl);

    const jumpControl = buildJumpControl(payload, agent);
    if (jumpControl) strip.append(jumpControl);

    strip.append(...buildWorkspaceControls(payload));
    card.append(strip);
  };

  const scan = () => {
    if (disposed) return;
    const candidates = document.querySelectorAll<HTMLElement>(
      '[data-local-conversation-item-target-ids], [data-turn-key], [data-testid*="tool"], .prose, pre'
    );
    for (const card of candidates) {
      if (alreadyEnhanced.has(card)) continue;
      const payload = parseCollabPayload(card.textContent || "");
      if (payload) {
        enhanceCard(card, payload);
      }
    }
  };

  const observer = new MutationObserver(() => scan());
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true,
  });
  scan();

  return {
    scan,
    dispose() {
      disposed = true;
      observer.disconnect();
      document.querySelectorAll(".harness-mix-collab-actions").forEach((node) => node.remove());
    },
  };
}
