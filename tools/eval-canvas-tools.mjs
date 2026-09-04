// 画布工具 E2E：保留必要工具，并验证图片拖动不会带动画布（真实鼠标事件 + sidecar 落盘）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { readFileSync } from "node:fs";

const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-battery";
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
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const call = pending.get(message.id); pending.delete(message.id);
  message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
});
await new Promise((resolve) => ws.on("open", resolve));
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails).slice(0, 500));
  return value.result?.value;
};
const drag = async (x1, y1, x2, y2) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 10; step += 1) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * step / 10), y: Math.round(y1 + (y2 - y1) * step / 10), button: "left", buttons: 1 });
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
};
const sidecar = () => JSON.parse(readFileSync(`${VAULT}/.marginalia/annotations.json`, "utf8"));

await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("配图-数字化与坪效.png")}` });
await sleep(1800);
await evaluate(`setWorkspaceMode("canvas")`);
await sleep(650);

const before = sidecar();
const spot = await evaluate(`(() => {
  const viewport = document.getElementById("viewport").getBoundingClientRect();
  const blocked = (element) => element && element.closest && element.closest('.card,.image-card,.draft-card,#page,#composer,.arrow-g,#toolbox');
  for (let y = viewport.top + 80; y < viewport.bottom - 100; y += 70) {
    for (let x = viewport.left + 18; x < viewport.right - 150; x += 70) {
      if (!blocked(document.elementFromPoint(x, y))) return { x, y };
    }
  }
  return { x: viewport.left + 18, y: viewport.top + 90 };
})()`);

// 箭头仍保留：按 Cowart 的 pointer 手势真实拖画，完成后输入标签。
await evaluate(`setTool("arrow")`);
await drag(spot.x, spot.y, spot.x + 110, spot.y + 34);
await sleep(350);
const labelShown = await evaluate(`!document.getElementById("arrow-label-editor").hidden`);
if (labelShown) {
  await evaluate(`document.getElementById("arrow-label-input").value = "需要强调"`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await sleep(650);
}

// 拖动画布图卡：图卡要移动，world transform 必须原封不动。
await evaluate(`setTool("select")`);
const imageBefore = await evaluate(`(() => {
  const card = document.querySelector(".image-card");
  if (!card) return null;
  const rect = card.getBoundingClientRect();
  return { id: card.dataset.id, x: rect.left + rect.width / 2, y: rect.top + Math.min(50, rect.height / 3), left: card.style.left, top: card.style.top, transform: document.getElementById("world").style.transform };
})()`);
if (imageBefore) {
  await drag(imageBefore.x, imageBefore.y, imageBefore.x + 74, imageBefore.y + 42);
  await sleep(800);
}
const imageAfter = await evaluate(`(() => {
  const card = document.querySelector(".image-card");
  return card ? { left: card.style.left, top: card.style.top, transform: document.getElementById("world").style.transform, selected: card.classList.contains("selected") } : null;
})()`);

const ui = await evaluate(`(() => {
  const toolbox = document.getElementById("toolbox").getBoundingClientRect();
  const viewport = document.getElementById("viewport").getBoundingClientRect();
  return {
    toolboxCentered: Math.abs((toolbox.left + toolbox.width / 2) - (viewport.left + viewport.width / 2)) < 2,
    toolboxAtBottom: Math.abs(viewport.bottom - toolbox.bottom - 18) < 2,
    obsoleteToolsGone: !document.querySelector('[data-tool="note"], [data-tool="board"]'),
    obsoleteNotesHidden: document.querySelectorAll("#notes-layer .note").length === 0,
  };
})()`);
const after = sidecar();
const storedImage = imageBefore ? after.images.find((item) => item.id === imageBefore.id) : null;
const imageMoved = Boolean(imageBefore && imageAfter && (imageBefore.left !== imageAfter.left || imageBefore.top !== imageAfter.top));
const canvasStayed = Boolean(imageBefore && imageAfter && imageBefore.transform === imageAfter.transform);
const storedMove = Boolean(storedImage && Math.abs(storedImage.x - Number.parseFloat(imageAfter.left)) < 0.5 && Math.abs(storedImage.y - Number.parseFloat(imageAfter.top)) < 0.5);

console.log("CANVAS-TOOLS:", JSON.stringify({
  arrowCreated: after.arrows.length === before.arrows.length + 1,
  labelShown,
  imageMoved,
  canvasStayed,
  storedMove,
  selected: imageAfter?.selected === true,
  ...ui,
}, null, 2));
ws.close();
