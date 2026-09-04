// 画布工具 E2E：三模式重构后箭头 / 便签 / 白板的回归验证（真实鼠标事件 + sidecar 落盘）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { readFileSync } from "node:fs";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").includes("4401"));
if (!page) { page = await (await fetch("http://127.0.0.1:9333/json/new?http://127.0.0.1:4401", { method: "PUT" })).json(); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const p = pm.get(m.id); pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await new Promise((r) => ws.on("open", r));
const evalv = async (expr) => {
  const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails.exception || ev.exceptionDetails).slice(0, 300));
  return ev.result ? ev.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realDrag = async (x1, y1, x2, y2) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i += 1) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + ((x2 - x1) * i) / 8), y: Math.round(y1 + ((y2 - y1) * i) / 8), button: "left", buttons: 1 });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
};
const realClick = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 });
};

const sidecar = () => {
  const s = JSON.parse(readFileSync("/tmp/coeditor-m7-vault/.marginalia/annotations.json", "utf8"));
  return { arrows: s.arrows.length, notes: s.notes.length, boards: s.notes.filter((n) => n.type === "board").length };
};
const before = sidecar();

// 打开 md 文档 → 切画布模式
await send("Page.navigate", { url: "http://127.0.0.1:4401/?doc=" + encodeURIComponent("研究设计笔记.md") });
await sleep(2400);
await evalv(`setWorkspaceMode('canvas')`);
await sleep(600);
// 画布空白区域坐标（视口右上方向，避开页面与卡片）
const spot = await evalv(`(() => {
  const vp = document.getElementById("viewport").getBoundingClientRect();
  const jit = (n) => Math.floor(Math.random() * n * 2) - n; // 随机偏移：脚本可在同一 vault 上重复运行
  return { x: vp.left + vp.width - 120 + jit(140), y: vp.top + 320 + jit(120) };
})()`);

/* ① 箭头（A 工具真实拖画，含标签弹层） */
await evalv(`setTool('arrow')`);
await realDrag(spot.x - 60, spot.y, spot.x + 60, spot.y + 40);
await sleep(450);
// 建完即弹标签编辑器：输入文字回车
const labelShown = await evalv(`(() => ({ editor: !document.getElementById("arrow-label-editor").hidden }))()`);
if (labelShown.editor) {
  await evalv(`(() => { const i = document.getElementById("arrow-label-input"); i.value = "这一列要强调口径来源"; return 1; })()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(600);
}
const afterArrow = sidecar();

/* ② 便签（N 工具点击放置） */
await evalv(`setTool('note')`);
await realClick(spot.x - 200, spot.y + 120);
await sleep(600);
const afterNote = sidecar();

/* ③ 白板（W 工具点击放置） */
await evalv(`setTool('board')`);
await realClick(spot.x - 200, spot.y + 520);
await sleep(600);
const afterBoard = sidecar();

/* DOM 断言：箭头 SVG / 便签卡 / 白板卡真实渲染 */
const dom = await evalv(`(() => ({
  arrowSvg: document.querySelectorAll("#arrows .arrow-g").length,
  notes: document.querySelectorAll("#notes-layer .note").length,
  boards: document.querySelectorAll("#notes-layer .note.board").length,
}))()`);
console.log("CANVAS-TOOLS:", JSON.stringify({
  before, afterArrow, afterNote, afterBoard, dom, labelShown,
  arrowCreated: afterArrow.arrows === before.arrows + 1,
  noteCreated: afterNote.notes === before.notes + 1,
  boardCreated: afterBoard.boards === afterNote.boards + 1,
}, null, 1));
ws.close(); process.exit(0);
