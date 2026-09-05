// v0.9.2 回归：侧栏新建文档（API + UI）、HTML 成品区点选/拖选定位源码、MCP resolve_annotations 闭环。
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-battery";
const HTML_DOC = "读书笔记-示例网页.html";
const NEW_DOC = "电池-新建-示例网页.html";
const api = async (url, options = {}) => {
  const response = await fetch(`${BASE}${url}`, options);
  const json = await response.json().catch(() => ({}));
  return { status: response.status, json };
};
const jsonOptions = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ---- 1. /api/create-file：创建 / 重名 409 / 越界消毒 ---- */
const createdApi = await api("/api/create-file", jsonOptions("POST", { name: "电池-新建-示例网页", ext: ".html" }));
const dup = await api("/api/create-file", jsonOptions("POST", { name: "电池-新建-示例网页.html", ext: ".html" }));
const traversal = await api("/api/create-file", jsonOptions("POST", { name: "..\/evil.md", ext: ".md" }));
const traversalRel = traversal.status === 200 && traversal.json.rel && !traversal.json.rel.includes("..") ? traversal.json.rel : null;

/* ---- 2. MCP resolve_annotations：标记后退出约束 ---- */
const DOC = "研究设计笔记.md";
let annNo = null;
try { annNo = (await api(`/api/annotations?p=${encodeURIComponent(DOC)}`, jsonOptions("POST", {
  kind: "text", quote: "坪效", prefix: "", suffix: "", body: "测试：MCP 闭环标记已处理", x: 850, y: 60,
}))).json.annotation.no; } catch { /* body 可能无 quote 匹配，仍可创建 */ }
const constraintsBefore = await api(`/api/constraints?p=${encodeURIComponent(DOC)}`);
const mcpResult = await new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(ROOT, "mcp-stdio.mjs"), VAULT]);
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.on("close", () => {
    const line = out.split("\n").map((l) => l.trim()).filter(Boolean).pop();
    try { resolve(JSON.parse(line).result); } catch { resolve(null); }
  });
  const version = constraintsBefore.json.constraints.find(a => a.no === annNo)?.version || 1;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "resolve_annotations", arguments: { doc: DOC, ids: [annNo], versions: { [annNo]: version }, note: "电池验证" } } })}\n`);
  child.stdin.end();
});
const constraintsAfter = await api(`/api/constraints?p=${encodeURIComponent(DOC)}`);
const resolvedOk = Boolean(mcpResult && mcpResult.content && JSON.parse(mcpResult.content[0].text).resolved.includes(annNo));
const constraintsDropped = constraintsAfter.json.count === constraintsBefore.json.count - 1;

/* ---- 3. 浏览器：HTML 成品区点选/拖选定位源码 + 侧栏新建 UI ---- */
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
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails).slice(0, 500));
  return value.result?.value;
};
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 });
};
const drag = async (x1, y1, x2, y2) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 12; step += 1) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * step / 12), y: Math.round(y1 + (y2 - y1) * step / 12), button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
};

await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(HTML_DOC)}` });
await sleep(1600);
await evaluate(`document.querySelector('[data-workspace-mode="edit"]').click()`);
await sleep(1400);
const editSplitShown = await evaluate(`!!(document.querySelector('.edit-split .edit-preview') && document.querySelector('.edit-split .CodeMirror'))`);

// 3a. 单击成品区 h1 → 左侧源码定位到 <h1> 所在行
const h1Point = await evaluate(`(() => {
  const frame = document.querySelector('.edit-preview');
  if (!frame || !frame.contentDocument) return null;
  const h1 = frame.contentDocument.querySelector('h1');
  if (!h1) return null;
  const r = h1.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
  return { x: fr.left + r.left + r.width * 0.5, y: fr.top + r.top + r.height * 0.5 };
})()`);
if (h1Point) await click(h1Point.x, h1Point.y);
await sleep(400);
const clickLocated = await evaluate(`(() => {
  const el = document.querySelector('.edit-split .CodeMirror');
  const cm = el && el.CodeMirror;
  if (!cm) return false;
  const text = cm.getLine(cm.getCursor().line) || '';
  return text.includes('<h1>') && text.includes('误区');
})()`);

// 3b. 拖选成品区文字 → 左侧源码选中同一段文字
// 注意：CodeMirror 5 的 .CodeMirror-selected 是「选中高亮矩形」（绝对定位 div，textContent 恒为空），
// 不是包住文字的 span —— 真实选区必须读 cm.getSelection() 或浏览器原生 selection。
const quotePoint = await evaluate(`(() => {
  const frame = document.querySelector('.edit-preview');
  const bq = frame && frame.contentDocument ? frame.contentDocument.querySelector('blockquote') : null;
  if (!bq) return null;
  const r = bq.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
  // blockquote 有 18px 左 padding：起点必须越过 padding 落在文字上，否则拖选建立不起来
  return { x1: fr.left + r.left + 22, y1: fr.top + r.top + r.height / 2, x2: fr.left + r.left + 130, y2: fr.top + r.top + r.height / 2 };
})()`);
let draggedText = "";
if (quotePoint) {
  await drag(quotePoint.x1, quotePoint.y1, quotePoint.x2, quotePoint.y2);
  await sleep(500);
  draggedText = await evaluate(`String(document.querySelector('.edit-preview').contentWindow.getSelection() || '').trim()`);
}
const located = await evaluate(`(() => {
  const cmEl = document.querySelector('.CodeMirror');
  const cm = cmEl && cmEl.CodeMirror;
  return { cm: cm ? cm.getSelection() : '', native: String(window.getSelection() || '') };
})()`);
// 源码选中的必须是「拖选的那段文字本身」，不是别的同片段
const needle = draggedText.slice(0, 4) || "误区一";
const selectionLocated = located.cm.length > 0 && located.cm.includes(needle) && located.native.includes(needle);

// 3c. 侧栏「＋」真实走一遍：选 HTML → 起名 → 创建并直接进入编辑
const plusPoint = await evaluate(`(() => { const b = document.getElementById('btn-new-file'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await click(plusPoint.x, plusPoint.y);
await sleep(250);
const htmlChip = await evaluate(`(() => { const b = document.querySelector('#new-file-pop [data-nf-ext=".html"]'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
if (htmlChip) await click(htmlChip.x, htmlChip.y);
await evaluate(`document.getElementById('nf-name').value = '电池-界面新建'`);
const createPoint = await evaluate(`(() => { const b = document.getElementById('nf-create'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await click(createPoint.x, createPoint.y);
await sleep(1600);
const uiCreated = await evaluate(`!!document.querySelector('#tree .file[data-path="电池-界面新建.html"]')`);
const uiEditOpened = await evaluate(`document.body.classList.contains('editing-doc') && document.getElementById('docpath').textContent.includes('电池-界面新建.html')`);
const topbarLean = await evaluate(`!document.querySelector('#bar .bar-tools > #btn-round') && !document.querySelector('#bar .bar-tools > #btn-edit-ask')`)
  && await evaluate(`!!document.querySelector('.view-menu-panel #btn-round') && !!document.querySelector('.view-menu-panel #btn-edit-ask')`);

console.log("V092:", JSON.stringify({
  apiCreated: createdApi.status === 200 && createdApi.json.rel === NEW_DOC,
  dupBlocked: dup.status === 409,
  traversalSanitized: Boolean(traversalRel),
  resolveMarked: resolvedOk,
  constraintsDropped,
  editSplitShown,
  clickLocated,
  selectionLocated,
  uiCreated,
  uiEditOpened,
  topbarLean,
}, null, 2));
ws.close();
