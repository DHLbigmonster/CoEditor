// PDF 按需渲染 E2E：12 页长文档，验证画布惰性绘制 + 滚动触发 + 文本层完整
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
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
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails).slice(0, 300));
  return ev.result ? ev.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await send("Page.navigate", { url: "http://127.0.0.1:4401/?doc=" + encodeURIComponent("长文档测试-12页.pdf") });
await sleep(1000);
// 先等 app.js 就绪（state 存在），再等 12 页结构
for (let i = 0; i < 80; i += 1) {
  const ready = await evalv(`typeof state !== "undefined"`).catch(() => false);
  if (ready) break;
  await sleep(250);
}
for (let i = 0; i < 60; i += 1) { // 高负载下 PDF 首屏可能很慢，给足耐心
  const n = await evalv(`document.querySelectorAll("#doc .pdf-page").length`);
  if (n >= 12) break;
  await sleep(500);
}
const counts = () => evalv(`(() => ({
  pages: document.querySelectorAll("#doc .pdf-page").length,
  painted: document.querySelectorAll("#doc .pdf-page canvas[data-painted]").length,
  spans: document.querySelectorAll("#doc .pdf-text span").length,
  lastPageText: (state.text || "").includes("LONGDOC12MARK"),
}))()`);
const before = await counts();
await sleep(1500); // IO 首批触发窗口
const initial = await counts();
// 滚动到文档底部（阅读模式：#viewport 是滚动容器）
await evalv(`(() => { const vp = document.getElementById("viewport"); vp.scrollTop = vp.scrollHeight; return vp.scrollTop; })()`);
await sleep(2000);
const afterScroll = await counts();
// 回到顶部
await evalv(`(() => { const vp = document.getElementById("viewport"); vp.scrollTo({ top: 0 }); return 1; })()`);
await sleep(1200);
const backTop = await counts();
console.log("LAZY:", JSON.stringify({
  structure: before,
  initial,
  afterScroll,
  backTop,
  lazyWorked: initial.painted < 12 && afterScroll.painted > initial.painted,
  textComplete: initial.lastPageText,
  spansComplete: initial.spans > 300,
}, null, 1));
ws.close(); process.exit(0);
