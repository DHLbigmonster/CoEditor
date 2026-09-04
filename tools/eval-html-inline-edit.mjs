// HTML 双击直改 E2E：真实双击 iframe 段落 → 面板 → 保存 → 源文件校验（URL 纯净 / 批注重锚定 / 还原）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { readFileSync } from "node:fs";
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-battery";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").includes(BASE.replace("http://127.0.0.1:", "")));
if (!page) { page = await (await fetch(`http://127.0.0.1:9333/json/new?${BASE}`, { method: "PUT" })).json(); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const p = pm.get(m.id); pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await new Promise((r) => ws.on("open", r));
const evalv = async (expr) => {
  const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails).slice(0, 300));
  return ev.result ? ev.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = async (x, y, cc) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: cc });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: cc });
};
const realDbl = async (x, y) => {
  await click(x, y, 1);
  await sleep(70);
  await click(x, y, 2); // 两次完整 click 让浏览器自然合成 dblclick（单对 clickCount:2 不稳定）
};
await send("Page.navigate", { url: `${BASE}/?doc=` + encodeURIComponent("读书笔记-示例网页.html") });
for (let i = 0; i < 30; i += 1) {
  const ready = await evalv(`(() => {
    const frame = document.getElementById("html-frame");
    return !!(frame && frame.contentDocument && frame.contentDocument.querySelector("p.meta[data-coedit]"));
  })()`);
  if (ready) break;
  await sleep(500);
}
const rect = await evalv(`(() => {
  const frame = document.getElementById("html-frame");
  const el = frame.contentDocument.querySelector("p.meta");
  if (!el) return null;
  const r = el.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
  return { x: r.left + fr.left + 80, y: r.top + fr.top + r.height / 2 };
})()`);
if (!rect) throw new Error("target paragraph not found");
await realDbl(rect.x, rect.y);
await sleep(450);
if (!await evalv(`!document.getElementById("html-edit").hidden`)) {
  await realDbl(rect.x + 12, rect.y + 6); // 负载下双击偶发未合成，重试一次
  await sleep(600);
}
const panel = await evalv(`(() => ({ shown: !document.getElementById("html-edit").hidden, tag: document.getElementById("html-edit-tag").textContent }))()`);
await evalv(`(() => { document.getElementById("html-edit-input").value = "示例网页 · 虚构内容 · 本句已被点击直改（E2E）"; return 1; })()`);
await evalv(`document.getElementById("html-edit-save").click()`);
await sleep(1700);
const file = readFileSync(`${VAULT}/读书笔记-示例网页.html`, "utf8");
const post = await evalv(`(() => ({
  anchors: document.getElementById("html-frame").contentDocument.querySelectorAll(".anchor").length,
}))()`);
// 还原
const rect2 = await evalv(`(() => {
  const frame = document.getElementById("html-frame");
  const el = [...frame.contentDocument.querySelectorAll("p")].find((p) => p.textContent.includes("本句已被点击直改"));
  if (!el) return null; const r = el.getBoundingClientRect(); const fr = frame.getBoundingClientRect();
  return { x: r.left + fr.left + 60, y: r.top + fr.top + r.height / 2 };
})()`);
let restored = false;
if (rect2) {
  await realDbl(rect2.x, rect2.y); await sleep(400);
  await evalv(`(() => { document.getElementById("html-edit-input").value = "示例网页 · 虚构内容 · 用于演示 CoEditor 对 HTML 的荧光标记与批注"; document.getElementById("html-edit-save").click(); return 1; })()`);
  await sleep(1500);
  restored = !readFileSync(`${VAULT}/读书笔记-示例网页.html`, "utf8").includes("本句已被点击直改");
}
console.log("INLINE-EDIT:" + JSON.stringify({
  panelShown: panel.shown, panelTag: panel.tag,
  fileHasNewText: file.includes("本句已被点击直改（E2E）"),
  noRawUrl: !file.includes("/api/raw"),
  noCoeditAttr: !file.includes("data-coedit"),
  stylePreserved: file.includes("<style>"),
  annotationReanchored: post.anchors > 0,
  restored,
}));
ws.close(); process.exit(0);
