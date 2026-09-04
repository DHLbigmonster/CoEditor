// CDP 驱动常驻 Chrome (9333)：导航 + 等待 + 截图 + 取 DOM 状态
// 用法: node shoot.mjs <url> <outfile.png> [waitMs] [evalJs]
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { readFileSync, writeFileSync } from "node:fs";

const [, , url, out, waitMsArg, evalJs, whArg] = process.argv;
const [vw, vh] = (whArg || "1440x900").split("x").map(Number);
const waitMs = Number(waitMsArg || 2500);

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
// 优先复用已打开目标 URL 的标签页，否则新开
let page = list.find(t => t.type === "page" && (t.url || "").startsWith(url.split("?")[0]));
if (!page) {
  const created = await (await fetch(`http://127.0.0.1:9333/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json();
  page = created;
} 
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on("message", d => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
await new Promise(r => ws.on("open", r));
await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: 2, mobile: false });
await send("Page.navigate", { url });
await new Promise(r => setTimeout(r, waitMs));
if (evalJs) {
  const expr = evalJs.startsWith("@") ? readFileSync(evalJs.slice(1), "utf8") : evalJs;
  const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  console.log("EVAL:", JSON.stringify(ev.result?.value ?? ev.result?.exceptionDetails ?? ev.result, null, 1));
  await new Promise(r => setTimeout(r, 800));
}
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(shot.data, "base64"));
console.log("SAVED:", out);
// 关闭本次用到的标签页（若是我们新开的）
await fetch(`http://127.0.0.1:9333/json/close/${page.id}`).catch(() => {});
ws.close();
process.exit(0);
