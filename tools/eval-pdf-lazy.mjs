// PDF 按需渲染 E2E：自包含（node 侧生成 12 页测试 PDF）+ 惰性绘制 + 滚动触发 + 文本层完整
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";

const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-battery";
const LONG_PDF = `${VAULT}/长文档测试-12页.pdf`;
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").includes("4401"));
if (!page) { page = await (await fetch("http://127.0.0.1:9333/json/new?" + BASE, { method: "PUT" })).json(); }
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

// ① 自包含：node 侧用 CDP printToPDF 生成 12 页测试 PDF
if (!existsSync(LONG_PDF)) {
  const gen = await (async () => {
    const tab = await (await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" })).json();
    const w = new WebSocket(tab.webSocketDebuggerUrl, { perMessageDeflate: false });
    let mid = 0; const out = new Map();
    const send2 = (m, p = {}) => new Promise((res, rej) => { const k = ++mid; out.set(k, { res, rej }); w.send(JSON.stringify({ id: k, method: m, params: p })); });
    w.on("message", (d) => { const m = JSON.parse(d); if (m.id && out.has(m.id)) { const p = out.get(m.id); out.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
    await new Promise((r) => w.on("open", r));
    await send2("Page.enable");
    const words = ["门店数字化", "样本筛选", "变量定义", "稳健性检验", "季节分布", "坪效指标", "外卖口径", "聚类标准误", "选择性偏差", "试点外推", "图例顺序", "数据回传"];
    let html = '<!doctype html><html><head><meta charset="utf-8"><style>@page { size: A4; margin: 24mm 18mm; } body { font-family: serif; font-size: 14px; line-height: 1.9; } section { page-break-after: always; }</style></head><body>';
    for (let i = 1; i <= 12; i += 1) {
      const w2 = words[i - 1];
      html += '<section><h2>第 ' + i + ' 节 · ' + w2 + '</h2>';
      for (let j = 1; j <= 6; j += 1) html += '<p>第 ' + i + '-' + j + ' 段：' + w2 + ' 相关段落，覆盖率与聚类调整细节从略。LONGDOC' + i + 'MARK</p>';
      html += '</section>';
    }
    html += '</body></html>';
    await send2("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
    await new Promise((r) => setTimeout(r, 1200));
    const pdf = await send2("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
    w.close();
    await fetch("http://127.0.0.1:9333/json/close/" + tab.id).catch(() => {});
    return { bytes: pdf.data.length, b64: pdf.data };
  })();
  writeFileSync(LONG_PDF, Buffer.from(gen.b64, "base64"));
  console.log("生成 12 页 PDF:", gen.bytes, "bytes");
}

// ② 打开长文档，等 app.js 就绪 + 12 页结构
await send("Page.navigate", { url: BASE + "/?doc=" + encodeURIComponent("长文档测试-12页.pdf") });
for (let i = 0; i < 80; i += 1) {
  const ready = await evalv(`typeof state !== "undefined"`);
  if (ready === true) break;
  await sleep(250);
}
for (let i = 0; i < 90; i += 1) { // 高负载下 PDF 首屏可能很慢
  const n = await evalv(`document.querySelectorAll("#doc .pdf-page").length`);
  if (n >= 12) break;
  await sleep(500);
}
const counts = () => evalv(`(() => ({
  pages: document.querySelectorAll("#doc .pdf-page").length,
  painted: document.querySelectorAll("#doc .pdf-page canvas[data-painted]").length,
  spans: document.querySelectorAll("#doc .pdf-text span").length,
  lastPageText: (typeof state !== "undefined" && state.text || "").includes("LONGDOC12MARK"),
}))()`);
const structure = await counts();
await sleep(1500);
const initial = await counts();
// ③ 滚动到底 → 底部页按需绘制
await evalv(`(() => { const vp = document.getElementById("viewport"); vp.scrollTop = vp.scrollHeight; return 1; })()`);
await sleep(2500);
const afterScroll = await counts();
// ④ 回到顶部
await evalv(`(() => { const vp = document.getElementById("viewport"); vp.scrollTo({ top: 0 }); return 1; })()`);
await sleep(1500);
const backTop = await counts();

console.log("LAZY:" + JSON.stringify({
  structure, initial, afterScroll, backTop,
  lazyWorked: initial.painted < 12 && afterScroll.painted > initial.painted,
  textComplete: initial.lastPageText === true || structure.lastPageText === true,
  spansComplete: (structure.spans || 0) > 100,
}, null, 1));
ws.close(); process.exit(0);
