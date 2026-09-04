// E2E：docx / HTML 真实鼠标拖选 → 浮条（补齐交互测试矩阵；只读断言零写入，不打扰用户会话）
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
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails).slice(0, 400));
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

/* ---------- docx 拖选 ---------- */
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("项目简报-山月斋数字化试点.docx")}` });
await sleep(2500);
result.docx = await evaluate(`(() => {
  const el = [...document.querySelectorAll("#doc p, #doc li, #doc h2, #doc td")].find((n) => n.textContent.trim().length > 10);
  if (!el) return { error: "docx no text" };
  const r = el.getBoundingClientRect();
  return { x1: r.left + 4, y1: r.top + r.height / 2, x2: r.right - 50, y2: r.top + r.height / 2, sample: el.textContent.trim().slice(0, 16) };
})()`);
if (result.docx && !result.docx.error) {
  await realDrag(result.docx.x1, result.docx.y1, result.docx.x2, result.docx.y2);
  await sleep(350);
  result.docxAfter = await evaluate(`(() => ({
    selLen: String(window.getSelection()).trim().length,
    menuShown: !document.getElementById("sel-menu").hidden,
    cursor: getComputedStyle(document.getElementById("doc")).cursor,
  }))()`);
}

/* ---------- HTML 拖选 ---------- */
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("读书笔记-示例网页.html")}` });
await sleep(2200);
result.html = await evaluate(`(() => {
  const el = [...document.querySelectorAll("#doc p, #doc li, #doc h2, #doc h3")].find((n) => n.textContent.trim().length > 10);
  if (!el) return { error: "html no text" };
  const r = el.getBoundingClientRect();
  return { x1: r.left + 4, y1: r.top + r.height / 2, x2: r.right - 50, y2: r.top + r.height / 2, sample: el.textContent.trim().slice(0, 16) };
})()`);
if (result.html && !result.html.error) {
  await realDrag(result.html.x1, result.html.y1, result.html.x2, result.html.y2);
  await sleep(350);
  result.htmlAfter = await evaluate(`(() => ({
    selLen: String(window.getSelection()).trim().length,
    menuShown: !document.getElementById("sel-menu").hidden,
  }))()`);
}

console.log("FORMATS-E2E:" + JSON.stringify(result, null, 1));
ws.close();
process.exit(0);
