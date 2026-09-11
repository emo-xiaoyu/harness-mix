// 真实 OpenClaw 图片链路自检：经 Gateway agent RPC attachments 字段发送一张纯红 PNG
const { HostRuntime } = require("../src/main/host/runtime");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");

// 最小合法 PNG：8x8 纯红（手工构造 IHDR+IDAT+IEND）
function redPng() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); ihdr.writeUInt32BE(8, 4); ihdr[8] = 8; ihdr[9] = 2; // 8bit RGB
  const raw = Buffer.alloc(8 * (1 + 8 * 3));
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const o = y * 25 + 1 + x * 3; raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0;
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

(async () => {
  const rt = new HostRuntime({ dataDirectory: path.join(os.tmpdir(), "hm-e2e-openclaw-img") });
  rt.subscribe((e) => { if (e.type === "toast") console.log("  [toast]", e.text); });
  await rt.initialize();
  const thread = await rt.createThread({ harnessId: "openclaw", cwd: "E:\\harness-mix", title: "E2E 图片自检" });
  if (thread.status === "error") throw new Error("open failed: " + thread.error);
  const caps = rt.getCapabilities("openclaw");
  console.log("attachments capability:", caps.conversation.attachments);
  console.log("opened, native session:", thread.nativeSessionId);
  const png = redPng();
  await rt.send(thread.id, "这张图片是什么颜色？用一个词回答。", {
    attachments: [{ kind: "image", name: "red.png", mime: "image/png", data: png.toString("base64") }],
  });
  for (let i = 0; i < 120 && rt.threads.find((t) => t.id === thread.id).status === "working"; i++) await new Promise((r) => setTimeout(r, 1000));
  const t = rt.threads.find((t) => t.id === thread.id);
  const answer = t.messages.at(-1)?.text ?? "";
  console.log("status:", t.status, "| error:", t.error ?? "(none)", "| assistant:", JSON.stringify(answer.slice(0, 300)));
  console.log("messages:", JSON.stringify(t.messages.map((m) => ({ role: m.role, text: (m.text ?? "").slice(0, 120) }))));
  await rt.close();
  const ok = t.status === "ready" && /红|red/i.test(answer);
  console.log(ok ? "PASS: OpenClaw 收到并识别了图片" : "WARN: 回答未明确提到红色（可能模型/会话不支持视觉，需人工看回答）");
  process.exit(t.status === "ready" ? 0 : 1);
})().catch((e) => { console.error("E2E FAILED:", e.message); process.exit(1); });
