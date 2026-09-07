// §0 纠偏 UI 级：v9c 构造 addressed 卡 → 断言「已修改 ✓」显示 / opacity / 历史入口；v9b 真实路径浮卡
import { writeFileSync } from "node:fs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4461";
const DOC = "验收10-14.md";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find(t => t.type === "page");
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", d => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const c = pm.get(m.id); pm.delete(m.id); m.error ? c.rej(new Error(JSON.stringify(m.error))) : c.res(m.result); } });
await new Promise(r => ws.on("open", r));
const evalv = async (expr) => { const v = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return v.exceptionDetails ? "EXC:" + JSON.stringify(v.exceptionDetails.exception?.description || v.exceptionDetails).slice(0, 200) : v.result?.value; };
const click = async (x, y) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 }); };
const drag = async (x1, y1, x2, y2) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 }); for (let i = 1; i <= 10; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * i / 10), y: Math.round(y1 + (y2 - y1) * i / 10), button: "left", buttons: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 }); };
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(DOC)}` });
await sleep(2600);
const shot = async n => { const s = await send("Page.captureScreenshot", { format: "png" }); writeFileSync(`/tmp/s5-${n}.png`, Buffer.from(s.data, "base64")); };
const out = {};
// 切「已修改历史」分组（构造样本已由 corrections.mjs 建：3 张 addressed）
await evalv(`(() => { const t = document.querySelector('[data-feedback="history"]'); if (t) t.click(); return 1; })()`);
await sleep(500);
await evalv(`(() => { const f = document.querySelector('#cards details.history-fold'); if (f) f.open = true; return 1; })()`);
await sleep(300);
out.v9c = await evalv(`(() => {
  const cards = [...document.querySelectorAll('#cards .card[data-status="addressed"]')];
  if (!cards.length) return 'no-card';
  const cs = getComputedStyle(cards[0]);
  return JSON.stringify({
    count: cards.length,
    doneBadge: cards[0].textContent.includes('已修改 ✓'),
    opacityOk: Number(cs.opacity) >= 0.55,
    visible: cs.display !== 'none',
  });
})()`);
// 历史入口可见（tabs 有「已修改历史」按钮）
out.historyEntry = await evalv(`(() => { const t = document.querySelector('[data-feedback="history"]'); return t ? t.textContent.trim() : null; })()`);
// v9b 真实路径：浮卡开着 → 选字 → 批注 → composer 打开 → 浮卡必须关
await evalv(`(() => { const t = document.querySelector('[data-feedback="pending"]'); if (t) t.click(); return 1; })()`);
await sleep(400);
await evalv(`(() => { const m = document.querySelector('.anchor[data-kind="highlight"]'); if (m) m.click(); return 1; })()`);
await sleep(400);
out.v9bFloatOpen = await evalv(`!!document.querySelector('.anchor-float-card')`);
// 用户会先关掉挡路的浮卡（Esc）再选字——模拟该行为后再拖选
await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
await sleep(300);
const pt = await evalv(`(async () => { const ps = [...document.querySelectorAll('#doc p')]; const p = ps.find(p => p.textContent.includes('第二段')); p.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 300)); const r = p.getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2, r.left + 220, r.top + r.height / 2]; })()`);
await drag(...pt); await sleep(400);
await evalv(`(() => { const b = [...document.querySelectorAll('#sel-menu button')].find(b => b.dataset.selAct === 'comment'); if (b) b.click(); return 1; })()`);
await sleep(500);
out.v9b = await evalv(`(() => JSON.stringify({ composerOpen: !document.getElementById('composer').hidden, floatClosed: !document.querySelector('.anchor-float-card') }))()`);
await evalv(`document.getElementById('composer-cancel').click()`);
await shot("v9c-addressed");
console.log("S6 纠偏（UI 级）:", JSON.stringify(out, null, 1));
writeFileSync(new URL("./corrections-ui.json", import.meta.url), JSON.stringify(out, null, 1));
ws.close(); process.exit(0);
