// 诊断2：确认 CM 选中后，用户能否真的看到高亮（原生选区 vs .CodeMirror-selected span）
import { spawn } from "node:child_process";
import { rmSync, cpSync } from "node:fs";
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import path from "node:path";

const ROOT = "/Users/chaos/Desktop/coeditor/marginalia";
const PORT = 4403;
const BASE = `http://127.0.0.1:${PORT}`;
const VAULT = "/tmp/coeditor-debug2";
const HTML_DOC = "读书笔记-示例网页.html";

rmSync(VAULT, { recursive: true, force: true });
cpSync(path.join(ROOT, "sample"), VAULT, { recursive: true });
const server = spawn(process.execPath, [path.join(ROOT, "server.mjs"), VAULT], {
  env: { ...process.env, COEDITOR_PORT: String(PORT), COEDITOR_DISABLE_NATIVE_PICKER: "1" },
  stdio: "ignore",
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 30; i += 1) {
  try { await (await fetch(`${BASE}/api/tree`)).json(); break; } catch { await sleep(300); }
}
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").startsWith(BASE));
if (!page) page = await (await fetch(`http://127.0.0.1:9333/json/new?${BASE}`, { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const c = ++id; pending.set(c, { resolve, reject }); ws.send(JSON.stringify({ id: c, method, params }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d); if (!m.id || !pending.has(m.id)) return;
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
  const f = document.querySelector('.edit-preview');
  const bq = f.contentDocument.querySelector('blockquote');
  const r = bq.getBoundingClientRect(); const fr = f.getBoundingClientRect();
  return { fx: fr.left, fy: fr.top, bx: r.left, by: r.top, bw: r.width, bh: r.height };
})()`);
await drag(geo.fx + geo.bx + 22, geo.fy + geo.by + geo.bh / 2, geo.fx + geo.bx + 130, geo.fy + geo.by + geo.bh / 2);
await sleep(600);

const probe = await evaluate(`(() => {
  const cmEl = document.querySelector('.CodeMirror');
  const cm = cmEl.CodeMirror;
  const selEls = [...document.querySelectorAll('.CodeMirror-selected')];
  return {
    cmFocused: cm.hasFocus(),
    activeIsCm: document.activeElement === cmEl || cmEl.contains(document.activeElement),
    activeTag: document.activeElement ? document.activeElement.tagName + '.' + document.activeElement.className : null,
    nativeSelInParent: String(window.getSelection()).slice(0, 40),
    nativeSelRanges: window.getSelection().rangeCount,
    cmSelection: cm.getSelection(),
    selElCount: selEls.length,
    selElHtml: selEls.map(n => n.outerHTML).slice(0, 2).join(' || ').slice(0, 200),
    styleSelectedTextOption: cm.options.styleSelectedText,
  };
})()`);
console.log("PROBE A (拖选后，CM 已 focus):", JSON.stringify(probe, null, 2));

// 场景B：失焦后再看（CM5 失焦时用 .CodeMirror-selected span 画出「非活动选区」）
const probeB = await evaluate(`(() => {
  const cmEl = document.querySelector('.CodeMirror');
  const cm = cmEl.CodeMirror;
  cm.getInputField().blur();
  document.body.focus();
  return new Promise((resolve) => setTimeout(() => {
    const selEls = [...document.querySelectorAll('.CodeMirror-selected')];
    resolve({
      cmFocused: cm.hasFocus(),
      selElCount: selEls.length,
      selElText: selEls.map(n => n.textContent).join('|').slice(0, 60),
      cmSelection: cm.getSelection(),
    });
  }, 300));
})()`);
console.log("PROBE B (失焦后):", JSON.stringify(probeB, null, 2));

ws.close(); server.kill();
