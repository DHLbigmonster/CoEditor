// E2E：PDF 区域框选批注（苹果预览式）+ 批注卡降噪验证
// 流程：真实鼠标在 PDF 第 1 页拖框 → composer 弹出 → 保存 → 区域 overlay 渲染 + 卡片无冗余徽标
//       → 切 2 列重渲染 → overlay 仍复位在正确页
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";

const BASE = "http://127.0.0.1:4400";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").startsWith("http://127.0.0.1:4400"));
if (!page) { page = await (await fetch("http://127.0.0.1:9333/json/new?http://127.0.0.1:4400", { method: "PUT" })).json(); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pendingMap = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pendingMap.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && pendingMap.has(m.id)) { const p = pendingMap.get(m.id); pendingMap.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
await new Promise((r) => ws.on("open", r));
const evaluate = async (expr) => {
  const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails).slice(0, 500));
  return ev.result ? ev.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function realDrag(x1, y1, x2, y2) {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 10; i += 1) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + ((x2 - x1) * i) / 10), y: Math.round(y1 + ((y2 - y1) * i) / 10), button: "left", buttons: 1 });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
}

const result = {};
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计-技术附录.pdf")}` });
await sleep(1200);
for (let i = 0; i < 20; i += 1) {
  if (await evaluate(`document.querySelectorAll("#doc .pdf-text span").length > 0`)) break;
  await sleep(500);
}

// 激活区域工具（走真实代码路径）
result.toolOn = await evaluate(`(setTool("region"), document.body.dataset.tool)`);
const before = await evaluate(`document.querySelectorAll("#cards .card").length`);

// 第 1 页中央框一块 20%~70% 的区域
const rect = await evaluate(`(() => {
  const p = document.querySelector('#doc .pdf-page[data-page="1"]');
  const r = p.getBoundingClientRect();
  return { x1: r.left + r.width * 0.2, y1: r.top + r.height * 0.2, x2: r.left + r.width * 0.7, y2: r.top + r.height * 0.5, page: p.dataset.page };
})()`);
await realDrag(rect.x1, rect.y1, rect.x2, rect.y2);
await sleep(300);
result.composer = await evaluate(`(() => ({
  shown: !document.getElementById("composer").hidden,
  quote: document.getElementById("composer-quote").textContent,
}))()`);
await evaluate(`(() => { const input = document.getElementById("composer-input"); input.value = "这一页的图表布局需要重排，图表标题与数据源分开"; })()`);
await evaluate(`document.getElementById("composer-save").click()`);
// PDF 重渲染（pdfjs 3 页）是异步的，轮询等 overlay 落位
let overlay = null;
for (let i = 0; i < 24; i += 1) {
  overlay = await evaluate(`(() => {
    const el = document.querySelector('#doc .pdf-page[data-page="1"] .region-layer .region[data-ann]');
    return el ? { ann: el.dataset.ann, left: el.style.left, top: el.style.top, width: el.style.width, height: el.style.height } : null;
  })()`);
  if (overlay) break;
  await sleep(500);
}
result.afterSave = await evaluate(`(() => {
  const card = [...document.querySelectorAll("#cards .card")].pop();
  return {
    cardTotal: document.querySelectorAll("#cards .card").length,
    quote: card ? card.querySelector(".c-quote").textContent.slice(0, 30) : null,
    bodySaved: card ? card.querySelector(".c-body").textContent.slice(0, 20) : null,
    activeCardBadgeLeak: [...document.querySelectorAll('#cards .card')].some((c) => c.dataset.status === "active" && c.querySelector(".c-badge")),
  };
})()`);
result.overlay = overlay;
result.lineDrawn = overlay ? await evaluate(`!!document.querySelector('#lines path[data-ann="${overlay.ann}"]')`) : false;

// 切 2 列 → 重渲染后区域应复位到第 1 页正确位置
await evaluate(`(() => { const b = document.querySelector('#bar-pdf-cols button[data-cols="2"]'); b.click(); })()`);
let colsOverlay = null;
for (let i = 0; i < 24; i += 1) {
  colsOverlay = await evaluate(`(() => {
    const el = document.querySelector('#doc.pdf-multi .pdf-page[data-page="1"] .region-layer .region[data-ann]');
    return el ? { left: el.style.left, top: el.style.top } : null;
  })()`);
  if (colsOverlay) break;
  await sleep(500);
}
result.afterCols = { multiOn: await evaluate(`document.getElementById("doc").classList.contains("pdf-multi")`), overlaySurvivesCols: !!colsOverlay, overlayLeft: colsOverlay ? colsOverlay.left : null };

console.log("REGION-E2E:" + JSON.stringify(result, null, 1));
ws.close();
process.exit(0);
