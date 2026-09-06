// UI 补充单综合验收：几何断言 + 状态断言 + 真实鼠标流程 + 截图集
// 隔离合成数据（4461），不触碰真实文件
import { writeFileSync } from "node:fs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4461";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find(t => t.type === "page");
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const c = pm.get(m.id); pm.delete(m.id); m.error ? c.rej(new Error(JSON.stringify(m.error))) : c.res(m.result); } });
await new Promise(r => ws.on("open", r));
const evalv = async (expr) => { const v = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return v.exceptionDetails ? "EXC:" + JSON.stringify(v.exceptionDetails.exception?.description || v.exceptionDetails).slice(0, 250) : v.result?.value; };
const drag = async (x1, y1, x2, y2) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 }); for (let i = 1; i <= 10; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * i / 10), y: Math.round(y1 + (y2 - y1) * i / 10), button: "left", buttons: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 }); };
const click = async (x, y) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 }); };
const shot = async name => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/accept-${name}.png`, Buffer.from(s.data, "base64")); };
const out = {};

// ===== A. 119% PDF + 反馈栏（对照用户截图场景）=====
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计-技术附录.pdf")}` });
await sleep(3400);
// 100%→119%：点 + 一次（fit≈1.07 → ~1.14-1.19 视容器而定，如实记录）
await evalv(`document.getElementById('btn-in').click()`);
await sleep(1900);
out.a119 = await evalv(`(() => {
  const vp = document.getElementById('viewport').getBoundingClientRect();
  const cards = document.getElementById('cards').getBoundingClientRect();
  return { zoom: document.getElementById('zoom').textContent, noOverlap: vp.right <= cards.left + 1, cardsClickable: !!document.elementFromPoint(cards.left + 30, cards.top + 80)?.closest('#cards') };
})()`);
await shot("pdf-119-percent");

// ===== B. 200% 放大：纸面被正文区裁切 =====
await evalv(`(() => { for (let i = 0; i < 3; i++) document.getElementById('btn-in').click(); return 1; })()`);
await sleep(1000);
// 等 PDF 重渲染宽度稳定（防抖 320ms + 重渲染）
let lastW = -1;
for (let i = 0; i < 10; i += 1) {
  const w = await evalv(`Math.round((document.querySelector('.pdf-page') || document.getElementById('page')).getBoundingClientRect().width)`);
  if (w === lastW && w > 0) break;
  lastW = w;
  await sleep(500);
}
out.b200 = await evalv(`(() => {
  const vp = document.getElementById('viewport').getBoundingClientRect();
  const cards = document.getElementById('cards').getBoundingClientRect();
  const page = document.getElementById('page').getBoundingClientRect();
  return { zoom: document.getElementById('zoom').textContent, docScrollOverflows: document.getElementById('doc').scrollWidth > vp.width + 2, pageClippedByViewport: vp.right <= cards.left, noOverlap: vp.right <= cards.left + 1, bodyHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth };
})()`);
await shot("pdf-200-percent");

// ===== C. 真实鼠标：选字保留 → 取消保留 → 批注 → 编辑 → 删除 =====
await evalv(`document.getElementById('btn-fit').click()`);
await sleep(1600);
const findSpan = needle => `(() => { const span = [...document.querySelectorAll('.textLayer span')].find(s => s.textContent.includes(${JSON.stringify(needle)})); if (!span) return null; const r = span.getBoundingClientRect(); return [r.left + 8, r.top + r.height / 2, Math.min(r.right - 20, innerWidth - 20), r.top + r.height / 2]; })()`;
// 清场：删掉历史留下的同 quote 保留（避免旧数据污染取消保留断言）
await evalv(`(async () => {
  const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计-技术附录.pdf'))).json()).annotations || [];
  for (const a of l.filter(x => x.kind === 'highlight' && x.quote.includes('抽样'))) {
    await fetch('/api/annotations?p=' + encodeURIComponent('研究设计-技术附录.pdf'), { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }) });
  }
  return true;
})()`);
await sleep(800);
const clickSel = async (act) => { await click(...Object.values(await evalv(`(() => { const b = [...document.querySelectorAll('#sel-menu button')].find(b => b.dataset.selAct === ${JSON.stringify(act)}); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`))); };
const pt = await evalv(findSpan("抽样"));
await drag(...pt); await sleep(400);
await clickSel("highlight"); await sleep(1000);
out.c1 = await evalv(`document.querySelector('[data-feedback="retained"]').getAttribute('aria-selected')`); // 自动切保留组
const cancel = await evalv(`(() => { const c = [...document.querySelectorAll('#cards .card')].find(x => x.querySelector('.c-kind.hl') && x.textContent.includes('抽样')); const b = c && [...c.querySelectorAll('button')].find(x => x.textContent === '取消保留'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })()`);
if (cancel) { await click(...cancel); await sleep(1200); }
// 按 quote 精确断言：同 quote 的数据与 DOM 锚点都消失（其他历史保留正确地保留）
out.c2dom = await evalv(`(() => [...document.querySelectorAll('.textLayer .anchor[data-kind="highlight"]')].filter(m => m.textContent.includes('抽样')).length)()`);
out.c2data = await evalv(`(async () => { const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计-技术附录.pdf'))).json()).annotations || []; return l.filter(a => a.kind === 'highlight' && a.quote.includes('抽样') && a.status !== 'deprecated').length; })()`); // 取消后同 quote 锚点与数据都应为 0
const pt2 = await evalv(findSpan("会员运营"));
await drag(...pt2); await sleep(400);
await clickSel("comment"); await sleep(400);
for (const ch of "U05验收批注") { const code = [...ch].map(c => c.codePointAt(0).toString(16)).join(""); await send("Input.insertText", { text: ch }); }
await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
await sleep(900);
out.c3 = await evalv(`[...document.querySelectorAll('#cards .card')].some(c => c.textContent.includes('U05验收批注'))`);
const editBtn = await evalv(`(() => { const c = [...document.querySelectorAll('#cards .card')].find(c => c.textContent.includes('U05验收批注')); const b = c && [...c.querySelectorAll('button')].find(x => x.textContent === '编辑'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })()`);
if (editBtn) { await click(...editBtn); await sleep(400); }
const ok = await evalv(`(() => { const c = [...document.querySelectorAll('#cards .card')].find(c => c.querySelector('.card-edit')); const t = c && c.querySelector('.card-edit'); if (!t) return null; t.value = 'U05验收批注（已编辑）'; return true; })()`);
if (ok) { await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 4, key: "s", code: "KeyS", windowsVirtualKeyCode: 83 }); await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 4, key: "s", code: "KeyS", windowsVirtualKeyCode: 83 }); await sleep(900); }
out.c4 = await evalv(`[...document.querySelectorAll('#cards .card')].some(c => c.textContent.includes('已编辑'))`);
const delBtn = await evalv(`(() => { const c = [...document.querySelectorAll('#cards .card')].find(c => c.textContent.includes('已编辑')); const b = c && [...c.querySelectorAll('button')].find(x => x.textContent === '删除'); if (!b) return null; const r = b.getBoundingClientRect(); return [r.left + r.width/2, r.top + r.height/2]; })()`);
if (delBtn) { await click(...delBtn); await sleep(1000); }
out.c5 = await evalv(`![...document.querySelectorAll('#cards .card')].some(c => c.textContent.includes('U05验收批注')) && ![...document.querySelectorAll('.textLayer .anchor')].some(a => a.textContent.includes('会员运营'))`);

// ===== D. 状态断言：分组数 = 列表数；保留不因 stale 归入待处理 =====
await send("Page.reload", { ignoreCache: true });
await sleep(3000);
out.d = await evalv(`(() => {
  const groups = { pending: 0, retained: 0, history: 0 };
  for (const a of window.__ann || []) {}
  return null;
})()`);
out.d = await evalv(`(async () => {
  const data = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计-技术附录.pdf'))).json()).annotations || [];
  const groupOf = a => a.kind === 'highlight' ? (a.status === 'deprecated' ? 'history' : 'retained') : (a.status === 'active' || a.status === 'stale') ? 'pending' : 'history';
  const expect = { pending: 0, retained: 0, history: 0 };
  for (const a of data) expect[groupOf(a)] += 1;
  const tabText = f => document.querySelector('[data-feedback="' + f + '"] b')?.textContent;
  const shown = { pending: Number(tabText('pending')), retained: Number(tabText('retained')), history: Number(tabText('history')) };
  // 切到 retained 验证列表数 = 计数
  document.querySelector('[data-feedback="retained"]').click();
  await new Promise(r => setTimeout(r, 400));
  const retainedCards = document.querySelectorAll('#cards .card').length;
  return JSON.stringify({ expect, shown, match: JSON.stringify(expect) === JSON.stringify(shown), retainedCards });
})()`);

// ===== E. 窄窗 640 =====
await send("Emulation.setDeviceMetricsOverride", { width: 640, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(700);
out.e640 = await evalv(`(() => {
  const vp = document.getElementById('viewport').getBoundingClientRect();
  const cards = document.getElementById('cards').getBoundingClientRect();
  return { cardsHidden: cards.width === 0, vpFull: Math.round(vp.width), bodyHScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 2 };
})()`);
await shot("narrow-640");

// ===== F. 200% 窄内容交叉 =====
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await sleep(500);
await evalv(`(() => { for (let i = 0; i < 5; i++) document.getElementById('btn-in').click(); return 1; })()`);
await sleep(1600);
out.f200 = await evalv(`(() => { const vp = document.getElementById('viewport').getBoundingClientRect(); const cards = document.getElementById('cards').getBoundingClientRect(); return { zoom: document.getElementById('zoom').textContent, noOverlap: vp.right <= cards.left + 1 }; })()`);
await shot("pdf-200-again");

console.log("ACCEPT:" + JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
