// 真实链路回归（起真实 pi 进程、走真实模型，类似 e2e:pi）：
// 场景：会话执行完后追加「图片+文字」，用户 1 秒内停止（落在 prompt preflight 窗口），
// 再发第二条消息。修复后期望：
//   1) 原生侧无僵尸运行——被取消的 run 在启动后立即被补停（assistant stopReason=aborted，
//      且 agent_settled 很快到达），不会在用户看不见的情况下跑完整个任务；
//   2) 被取消的消息（含图片）仍持久化在原生会话历史中，后续轮次的上下文能看到它。
const { HostRuntime } = require("../src/main/host/runtime");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "hm-cancel-race-"));
  const rt = new HostRuntime({ dataDirectory: path.join(os.tmpdir(), "hm-e2e-pi-cancel-" + Date.now()) });
  await rt.initialize();
  const thread = await rt.createThread({ harnessId: "pi", cwd, title: "取消竞态回归" });
  if (thread.status === "error") throw new Error("open failed: " + thread.error);
  const id = thread.id;
  const status = () => rt.threads.find((t) => t.id === id)?.status;

  // 预热一轮，制造「会话执行完之后」的状态（历史存在、原生会话已打开）
  await rt.send(id, "只回复两个字：收到");
  for (let i = 0; i < 90 && status() === "working"; i++) await sleep(1000);
  if (status() !== "ready") throw new Error("预热轮未就绪: " + status());
  console.log("预热完成，原生会话:", rt.threads.find((t) => t.id === id).nativeSessionId);

  const session = rt.sessions.get(id);
  if (!session) throw new Error("原生会话未保持打开");
  // 旁路记录原生事件（不改 Host 既有 hooks 行为）
  const nativeEvents = [];
  const originalOnEvent = session.process.hooks.onEvent;
  session.process.hooks.onEvent = (e) => {
    nativeEvents.push(e);
    if (["agent_start", "agent_end", "agent_settled", "turn_start", "turn_end"].includes(e.type)) console.log("[native]", e.type, e.message?.stopReason || "");
    if (e.type === "message_end") console.log("[native] message_end", e.message?.role, e.message?.stopReason || "");
    return originalOnEvent?.(e);
  };

  // 关键场景：图片+文字发出后 ~30ms 用户停止（落在投递/preflight 窗口内）
  const sendP = rt.send(id, "我说的是codex的这个宠物不是另外搞一个宠物 点击显示宠物是codex这个错误", {
    attachments: [{ name: "shot.png", kind: "image", mime: "image/png", data: PNG_B64 }],
  }).catch((e) => console.log("send#1 rejected:", e.message));
  const cancelAt = Date.now();
  await sleep(30);
  await rt.cancel(id);
  await sendP;
  console.log("已停止（+" + (Date.now() - cancelAt) + "ms），等待原生侧收尾…");

  // 修复后：agent_settled 应在 25s 内到达（补停生效）；僵尸运行则会长时间静默执行整个任务
  const settled = await (async () => {
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      if (nativeEvents.some((e) => e.type === "agent_settled")) return true;
      await sleep(250);
    }
    return false;
  })();
  if (!settled) throw new Error("取消后 25s 内原生 run 未收尾——疑似僵尸运行（补停未生效）");
  console.log("原生 run 已收尾（+" + (Date.now() - cancelAt) + "ms）");

  const data = await session.process.command({ type: "get_entries" });
  const msgs = data.entries.filter((e) => e.type === "message");
  const firstIdx = msgs.findIndex((e) => e.message.role === "user" && JSON.stringify(e.message.content).includes("宠物不是另外搞一个"));
  if (firstIdx < 0) throw new Error("被取消的「图片+文字」消息未持久化到原生会话历史");
  const first = msgs[firstIdx].message;
  const hasImage = Array.isArray(first.content) && first.content.some((b) => b.type === "image");
  if (!hasImage) throw new Error("被取消消息的图片块未进入原生会话历史");
  console.log("第一条消息（含图片）已在原生历史中 ✓");
  const after = msgs.slice(firstIdx + 1);
  const zombie = after.find((e) => e.message.role === "assistant" && (e.message.stopReason === "stop" || e.message.stopReason === "toolUse"));
  if (zombie) throw new Error("被取消的 run 仍然跑完了（assistant stopReason=" + zombie.message.stopReason + "）——僵尸运行未消除");
  const toolResult = after.find((e) => e.message.role === "toolResult");
  if (toolResult) throw new Error("被取消的 run 执行了工具调用——僵尸运行未消除");
  console.log("无僵尸运行痕迹（无完成的 assistant / toolResult）✓");

  // 第二条消息：应作为正常新轮次执行（而非排到僵尸之后），且上下文中能看到第一条消息
  await rt.send(id, "一句话回答：我上面那条带图片的消息里说的宠物是什么？不要调用任何工具");
  for (let i = 0; i < 120 && status() === "working"; i++) {
    await sleep(1000);
    if (i === 30) console.log("30s 仍在执行，原生事件数:", nativeEvents.length, "isRunning:", rt.execution.isRunning(id));
  }
  if (status() !== "ready") throw new Error("第二条消息的轮次未正常结束: " + status());
  const data2 = await session.process.command({ type: "get_entries" });
  const msgs2 = data2.entries.filter((e) => e.type === "message");
  const second = msgs2.find((e, i) => i > firstIdx && e.message.role === "user" && Array.isArray(e.message.content) && e.message.content.some((b) => b.type === "text" && b.text.includes("一句话回答")));
  if (!second) throw new Error("第二条消息「宠物」未进入原生会话历史");
  const answer = msgs2.slice(msgs2.indexOf(second) + 1).find((e) => e.message.role === "assistant");
  const answerText = answer && Array.isArray(answer.message.content) ? answer.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "";
  console.log("第二条消息已作答（stopReason=" + (answer?.message.stopReason || "?") + "）：", answerText.slice(0, 120).replace(/\n/g, " "));
  if (answer && answer.message.stopReason !== "stop") throw new Error("第二条消息的回复异常中止: " + answer.message.stopReason);
  console.log("context 顺序：图片消息 → abort 痕迹 → 「宠物」→ 回复，后续轮次可见第一条消息 ✓");

  await rt.close();
  console.log("E2E PASS: pi cancel-during-preflight race fixed");
  process.exit(0);
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
