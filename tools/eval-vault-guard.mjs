// vault 切换守卫回归：服务端切目录时，页面轮询不得虚推进批次，且视图正确重置
// 前置：server 已在 BASE 上以 VAULT 为根运行（battery 编排器负责）
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-m7-vault"; // 页面当前所在 vault
const AWAY = process.env.COEDITOR_E2E_AWAY || "/tmp";                    // 切走的目标（须与 VAULT 不同）
const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").startsWith(BASE));
if (!page) { page = await (await fetch(`http://127.0.0.1:9333/json/new?${BASE}`, { method: "PUT" })).json(); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on("message", (d) => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
await new Promise((r) => ws.on("open", r));
const evalv = async (expr) => {
  const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails).slice(0, 400));
  return ev.result ? ev.result.value : undefined;
};
import { mkdirSync } from "node:fs";
mkdirSync(AWAY, { recursive: true }); // 切走目标必须存在，否则 POST /api/vault 400、切走静默失败
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const postVault = (path) => fetch(`${BASE}/api/vault`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }) });
const rounds = async () => (await (await fetch(`${BASE}/api/rounds`)).json());

const roundBefore = await rounds();
// ① 页面在 VAULT 上打开 md
await send("Page.navigate", { url: `${BASE}/?doc=` + encodeURIComponent("研究设计笔记.md") });
await sleep(2400);
// ② 服务端切走 vault（模拟另一端选择了别的文件夹）
await postVault(AWAY);
// ③ 等 2 个轮询周期
await sleep(9500);
const after = await evalv(`(() => ({
  emptyShown: document.getElementById("empty").style.display !== "none",
  docEmpty: !document.getElementById("doc").innerHTML.length,
}))()`);
// ④ 切回（rounds 必须在切回后读——AWAY 是空目录，读到的是它的空 sidecar）
await postVault(VAULT);
await sleep(800);
const roundAfter = await rounds();
console.log("GUARD:" + JSON.stringify({
  after,
  activeRound_before: roundBefore.activeRound,
  activeRound_after: roundAfter.activeRound,
  guardWorked: after.emptyShown === true && after.docEmpty === true && roundBefore.activeRound === roundAfter.activeRound,
}));
ws.close(); process.exit(0);
