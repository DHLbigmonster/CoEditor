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
const evalv = async (expr) => { const v = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return v.exceptionDetails ? "EXC:" + JSON.stringify(v.exceptionDetails.exception?.description || v.exceptionDetails).slice(0, 250) : v.result?.value; };
const drag = async (x1, y1, x2, y2) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 }); for (let i = 1; i <= 10; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * i / 10), y: Math.round(y1 + (y2 - y1) * i / 10), button: "left", buttons: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 }); };
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
// 9b 真实路径：浮卡开着 → 拖选第二段文字 → 浮条批注 → openComposer → 浮卡应关
await evalv(`(() => { const m = document.querySelector('.anchor[data-kind="highlight"]'); if (m) m.click(); return 1; })()`);
await sleep(400);
console.log("浮卡开:", await evalv(`!!document.querySelector('.anchor-float-card')`));
const pt = await evalv(`(() => { const ps = [...document.querySelectorAll('#doc p')]; const p = ps.find(p => p.textContent.includes('第二段')); p.scrollIntoView({ block: 'center' }); return null; })()`);
await sleep(400);
const pt2 = await evalv(`(() => { const p = [...document.querySelectorAll('#doc p')].find(p => p.textContent.includes('第二段')); const r = p.getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2, r.left + 200, r.top + r.height / 2]; })()`);
await drag(...pt2);
await sleep(400);
await evalv(`(() => { const b = [...document.querySelectorAll('#sel-menu button')].find(b => b.dataset.selAct === 'comment'); if (b) b.click(); return 1; })()`);
await sleep(500);
console.log("9b 真实路径:", await evalv(`(() => JSON.stringify({ composerOpen: !document.getElementById('composer').hidden, floatClosed: !document.querySelector('.anchor-float-card') }))()`));
await evalv(`document.getElementById('composer-cancel').click()`);
// 9c：查历史分组实际内容
console.log("9c:", await evalv(`(() => {
  const t = document.querySelector('[data-feedback="history"]');
  if (!t) return 'no-history-tab';
  t.click();
  return 'clicked';
})()`));
await sleep(600);
console.log("history 卡:", await evalv(`(() => {
  const cards = [...document.querySelectorAll('#cards .card')];
  return JSON.stringify({ total: cards.length, statuses: cards.map(c => c.dataset.status), foldOpen: document.querySelector('#cards details.history-fold')?.open });
})()`));
ws.close(); process.exit(0);
