// v0.9.3：把「交给 Agent」的修改指令落成 vault 里的 .md（同名自动 -2，绝不覆盖）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-battery";
const DOC = "研究设计笔记.md";
const api = async (url, options = {}) => {
  const response = await fetch(`${BASE}${url}`, options);
  return { status: response.status, json: await response.json().catch(() => ({})) };
};
const jsonOptions = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* ---- 1. 先造一条 active 批注，否则指令里没有约束 ---- */
const created = await api(`/api/annotations?p=${encodeURIComponent(DOC)}`, jsonOptions("POST", {
  kind: "text", quote: "坪效", prefix: "", suffix: "", body: "指令落盘测试：这段要改", x: 850, y: 60,
}));
const annNo = created.json.annotation?.no ?? null;

/* ---- 2. 浏览器：交给 Agent → 存为 .md ---- */
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

await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(DOC)}` });
await sleep(1600);

// 打开 ••• 视图菜单 → 点「交给 Agent」
await evaluate(`document.getElementById('view-menu').open = true`);
await sleep(250);
const askPoint = await evaluate(`(() => { const b = document.getElementById('btn-edit-ask'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await click(askPoint.x, askPoint.y);
await sleep(700);
const panelShown = await evaluate(`!!document.getElementById('export-save-md') && !!document.getElementById('export-copy')`);

// 点「存为 .md 放进目录」
const savePoint = await evaluate(`(() => { const b = document.getElementById('export-save-md'); const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await click(savePoint.x, savePoint.y);
await sleep(900);

// 再存一次：应当生成 -2，而不是覆盖第一次
if (await evaluate(`!!document.getElementById('export-save-md')`)) {
  await click(savePoint.x, savePoint.y);
  await sleep(900);
}

const treeHasBrief = await evaluate(`!!document.querySelector('#tree .file[data-path="研究设计笔记-修改指令.md"]')`);

/* ---- 3. 落盘核验：文件真的在 vault 里、内容含批注号、两次都没被覆盖 ---- */
const inVault = (name) => {
  try { return readFileSync(path.join(VAULT, name), "utf8"); } catch { return null; }
};
const first = inVault("研究设计笔记-修改指令.md");
const second = inVault("研究设计笔记-修改指令-2.md");
const files = readdirSync(VAULT);
const briefFiles = files.filter((f) => f.includes("修改指令"));
// 「不覆盖」的判据是：第一次的文件仍在、且写入时间早于第二次（两份内容本就可能相同，比内容无意义）
const mtime1 = statSync(path.join(VAULT, "研究设计笔记-修改指令.md")).mtimeMs;
const mtime2 = statSync(path.join(VAULT, "研究设计笔记-修改指令-2.md")).mtimeMs;

console.log("BRIEF:", JSON.stringify({
  annCreated: Boolean(annNo),
  panelShown,
  treeHasBrief,
  brief1Exists: Boolean(first),
  brief1HasAnnotationNo: Boolean(first && annNo && first.includes(annNo)),
  brief1HasQuote: Boolean(first && first.includes("坪效")),
  brief1HasTargetFile: Boolean(first && first.includes(DOC)),
  brief2Exists: Boolean(second),
  brief1WrittenFirst: mtime1 <= mtime2,
  briefHasStamp: Boolean(first && /生成于\s*\d{4}\/\d{1,2}\/\d{1,2}/.test(first)),
  briefCount: briefFiles.length,
}, null, 2));
ws.close();
