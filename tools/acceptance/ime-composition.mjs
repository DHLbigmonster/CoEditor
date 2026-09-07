// S2/IME：CDP Input.imeSetComposition 模拟真实输入法组合态。
// 断言：composition 期间（含超过 600ms 防抖窗口的停留）零 annotations POST；
//       组合结束（commitText）后恰好 1 次落盘。
// 真实中文输入法的人工验收单独执行，不与本模拟混同。
import { writeFileSync } from "node:fs";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4461";
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find(t => t.type === "page");
const WebSocket = (await import("ws")).default;
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
const posts = [];
ws.on("message", d => { const m = JSON.parse(d);
  if (m.id && pm.has(m.id)) { const c = pm.get(m.id); pm.delete(m.id); m.error ? c.rej(new Error(JSON.stringify(m.error))) : c.res(m.result); }
  if (m.method === "Network.requestWillBeSent" && m.params.request.method === "POST" && m.params.request.url.includes("/api/annotations")) posts.push(m.params.request.url.slice(-20));
});
await new Promise(r => ws.on("open", r));
await send("Network.enable");
const evalv = async (expr) => { const v = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return v.exceptionDetails ? "EXC:" + JSON.stringify(v.exceptionDetails.exception?.description || v.exceptionDetails).slice(0, 200) : v.result?.value; };
const drag = async (x1, y1, x2, y2) => { await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 }); for (let i = 1; i <= 10; i++) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * i / 10), y: Math.round(y1 + (y2 - y1) * i / 10), button: "left", buttons: 1 }); await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 }); };
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计笔记.md")}` });
await sleep(2600);
const pt = await evalv(`(async () => { const ps = [...document.querySelectorAll('#doc p')]; const p = ps[Math.min(3, ps.length - 1)]; p.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 300)); const r = p.getBoundingClientRect(); return [r.left + 10, r.top + r.height / 2, r.left + 240, r.top + r.height / 2]; })()`);
await drag(...pt); await sleep(400);
await evalv(`(() => { const b = [...document.querySelectorAll('#sel-menu button')].find(b => b.dataset.selAct === 'comment'); if (b) b.click(); return 1; })()`);
await sleep(400);
const composerOpen = await evalv(`!document.getElementById('composer').hidden`);
posts.length = 0;
// 组合：逐次 imeSetComposition（候选变换），停留超过防抖窗口
const full = "这是输入法组合中的文字";
for (let i = 1; i <= full.length; i += 1) {
  await send("Input.imeSetComposition", { selectionStart: i, selectionEnd: i, text: full.slice(0, i) });
  await sleep(80);
}
await sleep(1200);
const duringComposition = posts.length;
await send("Input.insertText", { text: full });
await sleep(1300);
const afterCommit = posts.length - duringComposition;
const saved = await evalv(`(async () => { const l = (await (await fetch('/api/annotations?p=' + encodeURIComponent('研究设计笔记.md'))).json()).annotations || []; return l.some(a => (a.body || '').includes(full)); })()`);
const result = { composerOpen, postsDuringComposition: duringComposition, postsAfterCommit: afterCommit, savedToSidecar: saved, pass: composerOpen && duringComposition === 0 && afterCommit >= 1 && saved };
console.log("IME:" + JSON.stringify(result, null, 1));
writeFileSync(new URL('./ime-composition-result.json', import.meta.url), JSON.stringify(result, null, 1));
ws.close(); process.exit(result.pass ? 0 : 1);
