// 验收 14（页边标记键盘可达）+ 验收 9 三条件逐条断言
import { writeFileSync } from "node:fs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = "http://127.0.0.1:4461";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find(t => t.type === "page");
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const c = pm.get(m.id); pm.delete(m.id); m.error ? c.rej(new Error(JSON.stringify(m.error))) : c.res(m.result); } });
await new Promise(r => ws.on("open", r));
const evalv = async (expr) => { const v = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return v.exceptionDetails ? "EXC:" + JSON.stringify(v.exceptionDetails.exception?.description || v.exceptionDetails).slice(0, 200) : v.result?.value; };
const shot = async n => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/s5-${n}.png`, Buffer.from(s.data, "base64")); };
const out = {};
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("验收10-14.md")}` });
await sleep(2600);

// ===== 验收 14：页边标记存在、键盘可达（Tab 聚焦）、Enter 打开浮卡显示保留范围 =====
out.v14a = await evalv(`(() => {
  const marks = document.querySelectorAll('.retain-gutter-mark');
  const hl = document.querySelector('.anchor[data-kind="highlight"]');
  const hlBg = hl ? getComputedStyle(hl).backgroundColor : null;
  return JSON.stringify({ marks: marks.length, isButton: marks[0]?.tagName === 'BUTTON', highlightBgLowKey: hlBg, noUnderline: hl ? getComputedStyle(hl).boxShadow === 'none' : null, noConnector: document.querySelectorAll('#lines path').length === 0 });
})()`);
// 键盘：从 body 开始 Tab，直到焦点落在 retain-gutter-mark
let focused = false;
for (let i = 0; i < 40; i += 1) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(60);
  if (await evalv(`document.activeElement?.classList?.contains('retain-gutter-mark')`)) { focused = true; break; }
}
out.v14focus = focused;
// Enter 打开浮卡 → 显示保留范围与说明
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(500);
out.v14card = await evalv(`(() => {
  const f = document.querySelector('.anchor-float-card');
  if (!f) return false;
  return f.textContent.includes("已保留") || f.textContent.includes("保留");
})()`);
await shot("v14-gutter-focus-card");

// ===== 验收 9 三条件逐条断言 =====
// 9a. 无侧栏遮挡：viewport.right <= cards.left（900 与 1440）
for (const width of [900, 1440]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  const key = `v9noOverlapAt${width}`;
  out[key] = await evalv(`(() => { const vp = document.getElementById('viewport').getBoundingClientRect(); const c = document.getElementById('cards').getBoundingClientRect(); return vp.right <= c.left + 1; })()`);
}
// 9b. 悬浮卡不遮正在输入的内容：composer 打开时浮卡必须已关闭（点外自动关）
await evalv(`(() => { const vp = document.getElementById('viewport'); vp.scrollTop = 200; return 1; })()`);
await sleep(300);
// 打开浮卡（点击高亮）
await evalv(`(() => { const m = document.querySelector('.anchor[data-kind="highlight"]'); if (m) m.click(); return 1; })()`);
await sleep(400);
const floatOpen = await evalv(`!!document.querySelector('.anchor-float-card')`);
// 模拟开始输入（composer 打开）→ 浮卡应关闭
await evalv(`(() => { document.getElementById('composer').hidden = false; return 1; })()`);
await sleep(200);
out.v9floatVsComposer = await evalv(`(() => JSON.stringify({ floatWasOpen: ${floatOpen}, floatClosedWhenComposing: !document.querySelector('.anchor-float-card') || document.getElementById('composer').hidden === false && !document.querySelector('.anchor-float-card') }))()`);
await evalv(`(() => { document.getElementById('composer').hidden = true; return 1; })()`);
// 9c. 历史文字可读（opacity ≥ 0.55 且非 display:none）
out.v9historyReadable = await evalv(`(() => {
  const card = document.querySelector('#cards .card[data-status="addressed"]');
  if (!card) return 'no-addressed-card';
  const cs = getComputedStyle(card);
  return JSON.stringify({ opacity: Number(cs.opacity) >= 0.55, display: cs.display !== 'none', color: cs.color !== 'transparent' });
})()`);

console.log("S6 验收（14 + 9 三条件）:", JSON.stringify(out, null, 1));
writeFileSync("/tmp/s6-visual.json", JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
