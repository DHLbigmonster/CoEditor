const fs = await import("node:fs/promises");
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
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent("研究设计-技术附录.pdf")}` });
await sleep(3400);
// 从 textLayer 实际 span 取 quote 建 3 条普通批注
const quotes = await evalv(`(() => {
  const spans = [...document.querySelectorAll('.textLayer span')].filter(s => s.textContent.trim().length > 8);
  return [spans[5], spans[10], spans[15]].map(s => s ? s.textContent.trim().slice(0, 14) : null).filter(Boolean);
})()`);
console.log("quote 采样:", quotes);
for (const q of quotes) {
  console.log(q.slice(0, 8), await evalv(`(async () => {
    const r = await fetch('/api/annotations?p=' + encodeURIComponent('研究设计-技术附录.pdf'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'text', quote: ${JSON.stringify(q)}, prefix: '', suffix: '', body: '方框测试' }) });
    return 'POST ' + r.status;
  })()`));
}
await evalv(`window.loadAnnotations({ rerender: true })`);
await sleep(2500);
console.log(await evalv(`(() => {
  const marks = [...document.querySelectorAll('.textLayer .anchor')];
  const out = [];
  for (const m of marks.slice(0, 4)) {
    const cs = getComputedStyle(m);
    out.push({ kind: m.dataset.kind || 'comment', bg: cs.backgroundColor, shadow: cs.boxShadow === 'none' ? 'none' : cs.boxShadow.slice(0, 60), outline: cs.outlineWidth + ' ' + cs.outlineColor, radius: cs.borderRadius, tag: m.tagName, disp: cs.display });
  }
  return JSON.stringify({ count: marks.length, samples: out }, null, 1);
})()`));
const s = await send("Page.captureScreenshot", { format: "png" });
await fs.writeFile("/tmp/box-repro.png", Buffer.from(s.data, "base64"));
ws.close(); process.exit(0);
