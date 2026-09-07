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
await send("Page.reload", { ignoreCache: true });
await sleep(2600);
// 单元级：浮卡开 → 模拟 pending + openComposer → 断言浮卡关、composer 开
await evalv(`(() => { const m = document.querySelector('.anchor[data-kind="highlight"]'); if (m) m.click(); return 1; })()`);
await sleep(400);
console.log("浮卡开:", await evalv(`!!document.querySelector('.anchor-float-card')`));
console.log("9b:", await evalv(`(() => {
  window.__p = { quote: "第二段", prefix: "", suffix: "", worldY: 100, kind: "text", clientRect: { bottom: 300, left: 300 } };
  pending = window.__p;
  openComposer();
  return JSON.stringify({ composerOpen: !document.getElementById('composer').hidden, floatClosed: !document.querySelector('.anchor-float-card') });
})()`));
await evalv(`document.getElementById('composer-cancel').click()`);
ws.close(); process.exit(0);
