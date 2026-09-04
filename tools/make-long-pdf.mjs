// 生成 12 页测试 PDF（CDP printToPDF）用于按需渲染验收
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { writeFileSync } from "node:fs";
const created = await (await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" })).json();
const ws = new WebSocket(created.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const p = pm.get(m.id); pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await new Promise((r) => ws.on("open", r));
await send("Page.enable");
const words = ["门店数字化", "样本筛选", "变量定义", "稳健性检验", "季节分布", "坪效指标", "外卖口径", "聚类标准误", "选择性偏差", "试点外推", "图例顺序", "数据回传"];
let html = '<!doctype html><html><head><meta charset="utf-8"><style>@page { size: A4; margin: 24mm 18mm; } body { font-family: "Songti SC", serif; font-size: 14px; line-height: 1.9; } section { page-break-after: always; }</style></head><body>';
for (let i = 1; i <= 12; i += 1) {
  const w = words[i - 1];
  html += '<section><h2>第 ' + i + ' 节 · ' + w + '</h2><p>这是用于 CoEditor 按需渲染验收的第 ' + i + ' 页内容。' + w + ' 的讨论涉及口径定义、样本代表性与统计推断的可复现性。</p>';
  for (let j = 1; j <= 6; j += 1) {
    html += '<p>第 ' + i + '-' + j + ' 段：' + w + ' 相关段落，覆盖率、置信区间与聚类调整细节从略。LONGDOC' + i + 'MARK</p>';
  }
  html += '</section>';
}
html += '</body></html>';
await send("Page.navigate", { url: "data:text/html;charset=utf-8," + encodeURIComponent(html) });
await new Promise((r) => setTimeout(r, 1200));
const pdf = await send("Page.printToPDF", { printBackground: true, preferCSSPageSize: true });
writeFileSync("/tmp/coeditor-m7-vault/长文档测试-12页.pdf", Buffer.from(pdf.data, "base64"));
console.log("PDF generated:", pdf.data.length, "bytes");
await fetch("http://127.0.0.1:9333/json/close/" + created.id).catch(() => {});
ws.close(); process.exit(0);
