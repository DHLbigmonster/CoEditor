// v0.9.5：多 vault 最近打开记录（选择器顶部直切，去重/置顶/过滤失效目录）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";

const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-battery";
const AWAY = process.env.COEDITOR_E2E_AWAY || "/tmp/coeditor-battery-away";
const api = async (url, options = {}) => {
  const response = await fetch(`${BASE}${url}`, options);
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const jsonOptions = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const switchTo = (path) => api("/api/vault", jsonOptions("POST", { path }));

/* ---- 1. 造出两条记录：切走再切回（应去重置顶，不是追加） ---- */
await switchTo(AWAY);
await switchTo(VAULT);
const listed = await api("/api/recent-vaults");

/* ---- 2. 浏览器：打开选择器 → 最近列表可见、当前项标记、点击可切 ---- */
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
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 });
};

await send("Page.navigate", { url: `${BASE}/` });
await sleep(1600);
// #btn-vault 在电池里走 501 → 兜底打开网页选择器
await evaluate(`document.getElementById('btn-vault').click()`);
await sleep(900);

const modalOpen = await evaluate(`!document.getElementById('fs-modal').hidden`);
const recentCount = await evaluate(`document.querySelectorAll('#fs-recent .fs-recent-item').length`);
const currentMarked = await evaluate(`document.querySelectorAll('#fs-recent .fs-recent-item.cur').length === 1`);

// 点一条「非当前」的记录 → 应直接切换 vault
const otherPoint = await evaluate(`(() => {
  const item = [...document.querySelectorAll('#fs-recent .fs-recent-item')].find((n) => !n.classList.contains('cur'));
  if (!item) return null;
  const r = item.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, path: item.dataset.fsPath };
})()`);
let switched = null;
if (otherPoint) {
  await click(otherPoint.x, otherPoint.y);
  await sleep(1200);
  switched = await api("/api/vault");
}

console.log("RECENT:", JSON.stringify({
  listedCount: listed.json.vaults?.length ?? 0,
  deduped: (listed.json.vaults?.length ?? 0) === 2, // 切走再切回 = 两条，不是三条
  newestFirst: listed.json.vaults?.[0]?.path === VAULT,
  modalOpen,
  recentCount,
  currentMarked,
  clickTarget: otherPoint ? otherPoint.path : null,
  clickedSwitched: Boolean(switched && switched.json.root === otherPoint?.path),
}, null, 2));
ws.close();
