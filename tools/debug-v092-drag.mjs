// 诊断：拖选成品区 → 源码选中，为什么 selectionLocated=false
import { spawn } from "node:child_process";
import { rmSync, cpSync } from "node:fs";
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import path from "node:path";

const ROOT = "/Users/chaos/Desktop/coeditor/marginalia";
const PORT = 4402;
const BASE = `http://127.0.0.1:${PORT}`;
const VAULT = "/tmp/coeditor-debug";
const HTML_DOC = "读书笔记-示例网页.html";

rmSync(VAULT, { recursive: true, force: true });
cpSync(path.join(ROOT, "sample"), VAULT, { recursive: true });

const server = spawn(process.execPath, [path.join(ROOT, "server.mjs"), VAULT], {
  env: { ...process.env, COEDITOR_PORT: String(PORT), COEDITOR_DISABLE_NATIVE_PICKER: "1" },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ready = false;
for (let i = 0; i < 30; i += 1) {
  try { await (await fetch(`${BASE}/api/tree`)).json(); ready = true; break; } catch { await sleep(300); }
}
if (!ready) { console.error("server failed"); server.kill(); process.exit(2); }
console.log("server up on", BASE);

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

const evaluate = async (expression) => {
  const v = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (v.exceptionDetails) return { __error: JSON.stringify(v.exceptionDetails).slice(0, 300) };
  return v.result?.value;
};
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 });
};
const drag = async (x1, y1, x2, y2) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  for (let s = 1; s <= 12; s += 1) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * s / 12), y: Math.round(y1 + (y2 - y1) * s / 12), button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
};

await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(HTML_DOC)}` });
await sleep(1600);
await evaluate(`document.querySelector('[data-workspace-mode="edit"]').click()`);
await sleep(1400);

const geo = await evaluate(`(() => {
  const frame = document.querySelector('.edit-preview');
  if (!frame || !frame.contentDocument) return { error: 'no frame' };
  const bq = frame.contentDocument.querySelector('blockquote');
  const r = bq.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
  return { frame: { left: fr.left, top: fr.top, w: fr.width, h: fr.height },
    bq: { left: r.left, top: r.top, w: r.width, h: r.height },
    hasSync: frame.contentDocument.documentElement.dataset.coeditorSourceSync,
    bqText: bq.textContent.slice(0, 30) };
})()`);
console.log("GEO:", JSON.stringify(geo));

const p = {
  x1: geo.frame.left + geo.bq.left + 22,
  y1: geo.frame.top + geo.bq.top + geo.bq.h / 2,
  x2: geo.frame.left + geo.bq.left + 130,
  y2: geo.frame.top + geo.bq.top + geo.bq.h / 2,
};
console.log("DRAG POINTS:", JSON.stringify(p));
await drag(p.x1, p.y1, p.x2, p.y2);
await sleep(600);

const after = await evaluate(`(() => {
  const frame = document.querySelector('.edit-preview');
  const sel = frame.contentWindow.getSelection();
  const selText = String(sel);
  const rangeText = sel.rangeCount ? sel.getRangeAt(0).toString() : null;
  const selEls = [...document.querySelectorAll('.CodeMirror-selected')];
  const cm = document.querySelector('.CodeMirror') && document.querySelector('.CodeMirror').CodeMirror;
  const cmSel = cm ? cm.getSelection() : null;
  const activeLine = document.querySelector('.CodeMirror-code .CodeMirror-activeline');
  return {
    selText: selText.slice(0, 60),
    selLength: selText.length,
    rangeText: rangeText ? rangeText.slice(0, 60) : null,
    selElCount: selEls.length,
    selElText: selEls.map(n => n.textContent).join('|').slice(0, 80),
    cmSelection: cmSel ? cmSel.slice(0, 60) : null,
    activeLineText: activeLine ? activeLine.textContent.slice(0, 40) : null,
  };
})()`);
console.log("AFTER DRAG:", JSON.stringify(after, null, 2));

// 源码里到底有没有这段文本片段
const probe = await evaluate(`(() => {
  const cm = document.querySelector('.CodeMirror').CodeMirror;
  const src = cm.getValue();
  return {
    srcLen: src.length,
    idxYiwu: src.indexOf('误区一'),
    hasQuoteTag: src.indexOf('<blockquote>'),
    snippet: src.slice(src.indexOf('<blockquote>'), src.indexOf('<blockquote>') + 40),
  };
})()`);
console.log("SOURCE PROBE:", JSON.stringify(probe, null, 2));

ws.close(); server.kill();
