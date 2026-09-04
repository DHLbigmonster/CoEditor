// v0.9.3：批注卡 ↔ 正文 悬停互链（抽屉条目 / 画布卡 / 正文锚点 / 区域框，四侧任悬停其一其余点亮）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";

const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const DOC = "研究设计笔记.md";
const api = async (url, options = {}) => {
  const response = await fetch(`${BASE}${url}`, options);
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const jsonOptions = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const created = await api(`/api/annotations?p=${encodeURIComponent(DOC)}`, jsonOptions("POST", {
  kind: "text", quote: "坪效", prefix: "", suffix: "", body: "互链测试：这条要改", x: 850, y: 60,
}));
const annId = created.json.annotation?.id ?? null;

const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").startsWith(BASE));
if (!page) page = await (await fetch(`http://127.0.0.1:9333/json/new?${BASE}`, { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id; pending.set(callId, { resolve, reject });
  ws.send(JSON.stringify({ id: callId, method, params }));
});
ws.on("message", (data) => {
  const m = JSON.parse(data);
  if (!m.id || !pending.has(m.id)) return;
  const c = pending.get(m.id); pending.delete(m.id);
  m.error ? c.reject(new Error(JSON.stringify(m.error))) : c.resolve(m.result);
});
await new Promise((r) => ws.on("open", r));
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evaluate = async (expression) => {
  const v = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (v.exceptionDetails) throw new Error(JSON.stringify(v.exceptionDetails).slice(0, 400));
  return v.result?.value;
};
const move = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x), y: Math.round(y), buttons: 0 });
};
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 });
};

await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(DOC)}` });
await sleep(1600);
await evaluate(`document.getElementById('btn-drawer').click()`);
await sleep(500);

const anchorCount = await evaluate(`document.querySelectorAll('#doc .anchor[data-ann]').length`);
const drawerItems = await evaluate(`document.querySelectorAll('#drawer-body .d-item[data-id]').length`);

/* ---- 方向 A：悬停抽屉条目 → 正文锚点点亮 ---- */
const itemPoint = await evaluate(`(() => {
  const row = document.querySelector('#drawer-body .d-item[data-id]');
  if (!row) return null;
  row.scrollIntoView({ block: 'center' });
  const r = row.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, id: row.dataset.id };
})()`);
let cardToDoc = false; let cardToDocCleared = false;
if (itemPoint) {
  await move(itemPoint.x, itemPoint.y);
  await sleep(250);
  cardToDoc = await evaluate(`document.querySelectorAll('#doc .anchor.coeditor-peek, #doc .region.coeditor-peek').length > 0`);
  await move(20, 860); // 移到空白处
  await sleep(250);
  cardToDocCleared = await evaluate(`document.querySelectorAll('#doc .anchor.coeditor-peek, #doc .region.coeditor-peek').length === 0`);
}

/* ---- 方向 B：悬停正文锚点 → 抽屉条目点亮 ---- */
const anchorPoint = await evaluate(`(() => {
  const el = document.querySelector('#doc .anchor[data-ann]');
  if (!el) return null;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`);
let docToCard = false; let docToCardCleared = false;
if (anchorPoint) {
  await sleep(300);
  await move(anchorPoint.x, anchorPoint.y);
  await sleep(250);
  docToCard = await evaluate(`document.querySelectorAll('#drawer-body .d-item.coeditor-peek, .card.coeditor-peek').length > 0`);
  await move(20, 860);
  await sleep(250);
  docToCardCleared = await evaluate(`document.querySelectorAll('#drawer-body .d-item.coeditor-peek, .card.coeditor-peek').length === 0`);
}

console.log("PEEK:", JSON.stringify({
  annCreated: Boolean(annId),
  anchorCount,
  drawerItems,
  cardToDoc,
  cardToDocCleared,
  docToCard,
  docToCardCleared,
}, null, 2));
ws.close();
