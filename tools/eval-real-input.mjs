// 真实输入 E2E：CDP Input.dispatchMouseEvent 派发受信任鼠标事件（与用户真实拖拽同通道）
// 验证：① md 拖选不触发画布平移 + 浮条弹出 ② 保留落锚且无牵引线 ③ PDF 保留无文字重影
//       ④ 双击进编辑模式 ⑤ 文件夹选择器弹窗
// 前置：已 POST /api/vault 切到一次性副本 vault（测试数据不污染 sample）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";

const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const list = await (await fetch(`${BASE.replace("4400", "9333").replace("http", "http")}`)).json().catch(() => null);
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").startsWith("http://127.0.0.1:4401"));
if (!page) {
  page = await (await fetch("http://127.0.0.1:9333/json/new?http://127.0.0.1:4401", { method: "PUT" })).json();
}
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
await new Promise((r) => ws.on("open", r));
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });

const evaluate = async (expr) => {
  const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails).slice(0, 500));
  return ev.result ? ev.result.value : undefined; // returnByValue:true → {result:{type,value}}
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 真实拖选：mousePressed → 12 步 mouseMoved → mouseReleased
async function realDrag(x1, y1, x2, y2) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  const steps = 12;
  for (let i = 1; i <= steps; i += 1) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + ((x2 - x1) * i) / steps), y: Math.round(y1 + ((y2 - y1) * i) / steps), button: "left", buttons: 1 });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
}
async function realClick(x, y, clickCount = 1) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount });
}

const result = {};

/* ---------- ①② markdown：真实拖选 → 不平移 + 浮条 + 保留落锚 ---------- */
const nav1 = await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计笔记.md")}` });
if (nav1.errorText) throw new Error("navigate failed: " + nav1.errorText);
await sleep(2200);
result.md = await evaluate(`(() => {
  const doc = document.getElementById("doc");
  const p = [...doc.querySelectorAll("p, li, h2, h1")].find((el) => el.textContent.trim().length > 14);
  if (!p) return { error: "no paragraph" };
  const r = p.getBoundingClientRect();
  return { x1: r.left + 4, y1: r.top + r.height / 2, x2: r.right - 60, y2: r.top + r.height / 2, text: p.textContent.slice(0, 20) };
})()`);
if (result.md && !result.md.error) {
  const before = await evaluate(`document.getElementById("world").style.transform`);
  await realDrag(result.md.x1, result.md.y1, result.md.x2, result.md.y2);
  await sleep(350);
  result.mdAfter = await evaluate(`(() => ({
    transform: document.getElementById("world").style.transform,
    selection: String(window.getSelection()).slice(0, 40),
    selLen: String(window.getSelection()).trim().length,
    menuShown: !document.getElementById("sel-menu").hidden,
    cursor: getComputedStyle(document.getElementById("doc")).cursor,
  }))()`);
  result.md.noPan = before === result.mdAfter.transform;
  // 点浮条「保留」
  await evaluate(`document.querySelector('#sel-menu [data-sel-act="highlight"]').click()`);
  await sleep(900);
  result.mdHighlight = await evaluate(`(() => {
    const mark = document.querySelector('#doc mark.anchor[data-kind="highlight"]');
    const card = mark && document.querySelector('#cards .card[data-id="' + mark.dataset.ann + '"]');
    return {
      markInDoc: !!mark,
      noConnector: !!mark && !document.querySelector('#lines path[data-ann="' + mark.dataset.ann + '"]'),
      visibleNoPattern: !!card && /^\\d+-\\d+$/.test(card.querySelector('.c-id')?.textContent || ''),
      retainLabel: card?.querySelector('.c-kind')?.textContent === '保留',
      cards: document.querySelectorAll("#cards .card").length,
    };
  })()`);
}

/* ---------- ③ PDF：真实拖选 → 浮条 + 保留进文本层，文字透明避免覆盖 PDF canvas 重影 ---------- */
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计-技术附录.pdf")}` });
await sleep(1200);
for (let i = 0; i < 20; i += 1) {
  const ok = await evaluate(`document.querySelectorAll("#doc .pdf-text span").length > 0`);
  if (ok) break;
  await sleep(500);
}
result.pdfTarget = await evaluate(`(() => {
  const span = [...document.querySelectorAll("#doc .pdf-text span")].find((s) => s.textContent.trim().length >= 8);
  if (!span) return { error: "no pdf span" };
  const r = span.getBoundingClientRect();
  return { x1: r.left + 2, y1: r.top + r.height / 2, x2: r.left + Math.max(30, r.width * 0.7), y2: r.top + r.height / 2, text: span.textContent.slice(0, 20) };
})()`);
if (result.pdfTarget && !result.pdfTarget.error) {
  await realDrag(result.pdfTarget.x1, result.pdfTarget.y1, result.pdfTarget.x2, result.pdfTarget.y2);
  await sleep(350);
  result.pdfAfter = await evaluate(`(() => ({
    selLen: String(window.getSelection()).trim().length,
    menuShown: !document.getElementById("sel-menu").hidden,
  }))()`);
  await evaluate(`document.querySelector('#sel-menu [data-sel-act="highlight"]').click()`);
  await sleep(900);
  result.pdfHighlight = await evaluate(`(() => ({
    markInTextLayer: !!document.querySelector('#doc .pdf-text mark.anchor[data-kind="highlight"]'),
    highlightColor: (() => { const m = document.querySelector('#doc .pdf-text mark.anchor[data-kind="highlight"]'); return m ? getComputedStyle(m).background.slice(0, 60) : null; })(),
    textLayerTransparent: (() => { const m = document.querySelector('#doc .pdf-text mark.anchor[data-kind="highlight"]'); return m ? getComputedStyle(m).color === 'rgba(0, 0, 0, 0)' : false; })(),
  }))()`);
}

/* ---------- ④ markdown 双击进编辑（真实双击） ---------- */
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计笔记.md")}` });
await sleep(2200);
result.dbl = await evaluate(`(() => {
  const doc = document.getElementById("doc");
  const p = [...doc.querySelectorAll("p, li")].find((el) => el.textContent.trim().length > 14);
  const r = p.getBoundingClientRect();
  return { x: r.left + 80, y: r.top + r.height / 2 };
})()`);
if (result.dbl && !result.dbl.error) {
  await realClick(result.dbl.x, result.dbl.y, 2);
  await sleep(450);
  result.editMode = await evaluate(`(() => ({
    editing: document.body.classList.contains("editing-doc"),
    textarea: !!document.getElementById("md-editor"),
    cursorInEditor: document.getElementById("md-editor") ? getComputedStyle(document.getElementById("md-editor")).cursor : null,
  }))()`);
  await evaluate(`document.getElementById("edit-cancel") && document.getElementById("edit-cancel").click()`);
  await sleep(400);
}

/* ---------- ⑤ 文件夹选择器 ---------- */
await evaluate(`document.getElementById("btn-vault").click()`);
await sleep(600);
result.fsModal = await evaluate(`(() => ({
  shown: !document.getElementById("fs-modal").hidden,
  items: document.querySelectorAll("#fs-list .fs-item").length,
  quick: document.querySelectorAll("#fs-quick button").length,
  cur: document.getElementById("fs-cur").textContent,
  crumb: document.getElementById("fs-crumb").textContent.slice(0, 60),
}))()`);
await evaluate(`[...document.querySelectorAll("#fs-quick button")].find((b) => b.textContent === "主目录").click()`);
await sleep(500);
result.fsQuick = await evaluate(`document.getElementById("fs-cur").textContent`);
await evaluate(`document.getElementById("fs-close").click()`);
await sleep(200);
result.fsClosed = await evaluate(`document.getElementById("fs-modal").hidden`);

console.log("E2E:" + JSON.stringify(result, null, 1));
ws.close();
process.exit(0);
