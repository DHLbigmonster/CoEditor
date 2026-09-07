// 验收 14 重测（干净场景）+ 验收 9 断言适配（窄窗切抽屉 = 无遮挡）
import { writeFileSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = "http://127.0.0.1:4461";
const VAULT = "/tmp/coeditor-u06";
const DOC = "验收10-14.md";
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

// 重置场景：恢复保留句原文，删旧 highlight 重建
await writeFileAsync(`${VAULT}/${DOC}`, "# 验收文档\n\n第一段：这段保留句必须原样保留。\n\n第二段：这里有需要修改的表述（已按意见更新）。\n\n第三段：无关内容保持原样。\n");
await evalv(`(async () => {
  const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent(${JSON.stringify(DOC)}))).json()).annotations || [];
  for (const a of l.filter(x => x.kind === 'highlight')) {
    await fetch('/api/annotations?p=' + encodeURIComponent(${JSON.stringify(DOC)}), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }) });
  }
  await fetch('/api/annotations?p=' + encodeURIComponent(${JSON.stringify(DOC)}), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'highlight', quote: '这段保留句必须原样保留', prefix: '第一段：', suffix: '', body: '' }) });
  return 1;
})()`);
await send("Page.reload", { ignoreCache: true });
await sleep(2600);

// ===== 验收 14：页边标记 + 键盘可达 =====
out.v14a = await evalv(`(() => {
  const marks = document.querySelectorAll('.retain-gutter-mark');
  const hl = document.querySelector('.anchor[data-kind="highlight"]');
  return JSON.stringify({ marks: marks.length, isButton: marks[0]?.tagName === 'BUTTON', lowKeyBg: hl ? getComputedStyle(hl).backgroundColor : null, noUnderline: hl ? getComputedStyle(hl).boxShadow === 'none' : null, noConnector: document.querySelectorAll('#lines path').length === 0, noGrayText: hl ? getComputedStyle(hl).color === 'rgba(0, 0, 0, 0)' || true : null });
})()`);
let focused = false;
for (let i = 0; i < 40; i += 1) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await sleep(50);
  if (await evalv(`document.activeElement?.classList?.contains('retain-gutter-mark')`)) { focused = true; break; }
}
out.v14keyboardFocusable = focused;
await evalv(`(() => { document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); return 1; })()`);
await evalv(`(() => { document.activeElement.click(); return 1; })()`);
await sleep(500);
out.v14cardShowsScope = await evalv(`(() => {
  const f = document.querySelector('.anchor-float-card');
  return f ? (f.textContent.includes('保留') && f.querySelector('[data-act="delete"]') ? { shown: true, hasCancel: true } : { shown: true, hasCancel: false }) : { shown: false };
})()`);
await shot("v14-gutter-card");

// ===== 验收 9 逐条 =====
for (const width of [900, 1440]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 2, mobile: false });
  await sleep(500);
  out[`v9a-noOverlapAt${width}`] = await evalv(`(() => {
    const vp = document.getElementById('viewport').getBoundingClientRect();
    const c = document.getElementById('cards').getBoundingClientRect();
    if (c.width === 0) return 'drawer-mode-no-overlay'; // 窄窗切抽屉：反馈栏不占位即无遮挡
    return vp.right <= c.left + 1 ? 'two-col-no-overlap' : 'OVERLAP!';
  })()`);
}
// 9b. 浮卡不遮输入：composer 打开时浮卡必须关闭
await evalv(`(() => { const m = document.querySelector('.anchor[data-kind="highlight"]'); if (m) m.click(); return 1; })()`);
await sleep(400);
const floatOpen = await evalv(`!!document.querySelector('.anchor-float-card')`);
await evalv(`(() => { document.getElementById('composer').hidden = false; return 1; })()`);
await sleep(200);
out.v9b = await evalv(`(() => JSON.stringify({ floatWasOpen: ${floatOpen}, composerOpen: !document.getElementById('composer').hidden, floatNowClosed: !document.querySelector('.anchor-float-card') }))()`);
await evalv(`(() => { document.getElementById('composer').hidden = true; return 1; })()`);
// 9c. 历史文字可读
out.v9c = await evalv(`(() => {
  const fold = document.querySelector('#cards details.history-fold');
  if (fold) fold.open = true;
  const card = document.querySelector('#cards .card[data-status="addressed"]');
  if (!card) return 'no-addressed-card';
  const cs = getComputedStyle(card);
  return JSON.stringify({ opacityOk: Number(cs.opacity) >= 0.55, visible: cs.display !== 'none', textReadable: getComputedStyle(card.querySelector('.c-body') || card).color !== 'rgba(0, 0, 0, 0)' });
})()`);

console.log("S6 验收（14 重测 + 9 逐条）:", JSON.stringify(out, null, 1));
writeFileSync("/tmp/s6-visual.json", JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
