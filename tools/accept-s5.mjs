// S5 综合验收：补充单 9 条（隔离副本 4461，真实鼠标）
import { writeFileSync } from "node:fs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = "http://127.0.0.1:4461";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find(t => t.type === "page");
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const c = pm.get(m.id); pm.delete(m.id); m.error ? c.rej(new Error(JSON.stringify(m.error))) : c.res(m.result); } });
await new Promise(r => ws.on("open", r));
const evalv = async (expr) => { const v = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return v.exceptionDetails ? "EXC:" + JSON.stringify(v.exceptionDetails.exception?.description || v.exceptionDetails).slice(0, 200) : v.result?.value; };
const shot = async n => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/s5-${n}.png`, Buffer.from(s.data, "base64")); };
const drag = async (x1, y1, x2, y2) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 }); for (let i = 1; i <= 10; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * i / 10), y: Math.round(y1 + (y2 - y1) * i / 10), button: "left", buttons: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 }); };
const click = async (x, y) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 }); };
const out = {};

// ===== 验收 1：PDF 首开正常阅读、无空间总览、无工具条；MD 编辑按钮显示 =====
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计-技术附录.pdf")}` });
await sleep(3400);
out.v1pdf = await evalv(`(() => JSON.stringify({
  mode: document.body.dataset.workspaceMode,
  toolboxGone: !document.getElementById('toolbox') || getComputedStyle(document.getElementById('toolbox')).display === 'none' || document.getElementById('toolbox').getBoundingClientRect().width === 0,
  noTransform: (document.getElementById('world').style.transform || 'none') === 'none',
  zoom100: document.getElementById('zoom').textContent === '100%',
  canvasInMenu: !!document.getElementById('btn-canvas-mode'),
  canvasGoneTop: !document.querySelector('#workspace-modes [data-workspace-mode="canvas"]'),
  editHidden: document.querySelector('#workspace-modes [data-workspace-mode="edit"]').hidden,
}))()`);
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计笔记.md")}` });
await sleep(2400);
out.v1md = await evalv(`JSON.stringify({ editShown: !document.querySelector('#workspace-modes [data-workspace-mode="edit"]').hidden, mode: document.body.dataset.workspaceMode })`);

// ===== 验收 2：选字 → 批注 → 输入 → 自动落盘 → 刷新不丢 =====
// 先滚动目标段落进视口再取坐标（md 长文档段落可能在视口外）
const pt = await evalv(`(async () => {
  const ps = [...document.querySelectorAll('#doc p')];
  const p = ps.find(p => p.textContent.includes('剔除')) || ps[Math.min(4, ps.length - 1)];
  p.scrollIntoView({ block: 'center' });
  await new Promise(r => setTimeout(r, 300));
  const r = p.getBoundingClientRect();
  return [r.left + 10, r.top + r.height / 2, r.left + 260, r.top + r.height / 2];
})()`);
await drag(...pt); await sleep(400);
await click(...Object.values(await evalv(`(() => { const b = [...document.querySelectorAll('#sel-menu button')].find(b => b.dataset.selAct === 'comment'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`)));
await sleep(400);
await send("Input.insertText", { text: "S5验收：这一段需要补充数据来源。" });
await sleep(1000); // 600ms 防抖 + 落盘
out.v2saved = await evalv(`(async () => { const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || []; return l.some(a => (a.body || '').includes('S5验收')); })()`);
await send("Page.reload", { ignoreCache: false });
await sleep(2200);
out.v2survivesReload = await evalv(`(async () => { const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || []; return l.some(a => (a.body || '').includes('S5验收')); })()`);

// ===== 验收 3：旧修订回写被拒、新意见保持（resolve Reviewed 的 versions 校验已存在——模拟）=====
const ann = await evalv(`(async () => { const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || []; const hit = l.find(a => (a.body || '').includes('S5验收')); return JSON.stringify({ id: hit.id, no: hit.no, ver: hit.version }); })()`);
const a3 = JSON.parse(ann);
// 用户改意见（修订号 +1）
await evalv(`(async () => { const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || []; const hit = l.find(a => a.id === ${JSON.stringify(a3.id)}); await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'), { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: hit.id, body: hit.body + '（用户已更新）' }) }); return 1; })()`);
await sleep(600);
// Agent 用旧版本 resolve → 应被拒（version-mismatch）
out.v3 = await evalv(`(async () => { const r = await (await fetch('/api/resolve?p=' + encodeURIComponent('研究设计笔记.md'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [${JSON.stringify(a3.no)}], versions: { [${JSON.stringify(a3.no)}]: ${a3.ver} } }) })).json(); return JSON.stringify({ skipped: r.skipped, stillActive: ((await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || []).find(a => a.id === ${JSON.stringify(a3.id)}).status }); })()`);

// ===== 验收 4：五条意见只 resolve 三条 → 只三条灰显 =====
// 造 5 条意见（3 条 resolve）
for (let i = 0; i < 5; i++) {
  await evalv(`(async () => { await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'text', quote: '剔除', body: '部分完成测试 ${i + 1}' }) }); return 1; })()`);
}
await sleep(500);
out.v4 = await evalv(`(async () => {
  const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || [];
  const five = l.filter(a => (a.body || '').includes('部分完成测试'));
  const three = five.slice(0, 3);
  for (const a of three) await fetch('/api/resolve?p=' + encodeURIComponent('研究设计笔记.md'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [a.no], versions: { [a.no]: a.version } }) });
  const after = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || [];
  const addressed = after.filter(a => (a.body || '').includes('部分完成测试') && a.status === 'addressed').length;
  const activeLeft = after.filter(a => (a.body || '').includes('部分完成测试') && a.status === 'active').length;
  return JSON.stringify({ addressed, activeLeft, partialOk: addressed === 3 && activeLeft === 2 });
})()`);

console.log("S5 验收（1-4）:", JSON.stringify(out, null, 1));
await shot("md-1440");
ws.close(); process.exit(0);
