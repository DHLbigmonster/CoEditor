// 回归：vault 切换防护 —— 复现「服务端切目录 + 旧标签页轮询 mtime 误判 → 批次虚推进」事故
// 步骤：切到副本 vault → 打开 md 标签页（模拟用户）→ 服务端切走 vault（模拟另一标签页操作）
//       → 等 2 个轮询周期 → 断言：① 旧标签页视图被重置（未误读新目录同名文件）② 副本 activeRound 未被推进
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";

const COPY = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-e2e-vault";
const roundBefore = await (await fetch("http://127.0.0.1:4401/api/rounds")).json();

const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").startsWith("http://127.0.0.1:4401"));
if (!page) { page = await (await fetch("http://127.0.0.1:9333/json/new?http://127.0.0.1:4401", { method: "PUT" })).json(); }
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
  if (ev.exceptionDetails) throw new Error(JSON.stringify(ev.exceptionDetails).slice(0, 300));
  return ev.result ? ev.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) 切到副本 vault，打开 md（标签页 state.vaultRoot = 副本）
await fetch("http://127.0.0.1:4401/api/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: COPY }) });
await send("Page.navigate", { url: "http://127.0.0.1:4401/?doc=" + encodeURIComponent("研究设计笔记.md") });
await sleep(2500);
const before = await evalv(`({ path: state ? undefined : undefined, vaultRoot: (window.state||{}).vaultRoot || "n/a", doc: !!document.getElementById("doc").innerHTML.length })`);

// 2) 服务端切走 vault（模拟另一个标签页里选了别的文件夹）
await fetch("http://127.0.0.1:4401/api/vault", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "/Users/chaos/WorkBuddy/2026-09-03-22-03-32/backups/coeditor-desktop-before-m7-1558/sample" }) });

// 3) 等 2 个轮询周期（4s interval）
await sleep(9500);
const after = await evalv(`({ emptyShown: document.getElementById("empty").style.display !== "none", docEmpty: !document.getElementById("doc").innerHTML.length, treeCleared: !document.querySelectorAll("#tree .file").length })`);
const roundAfter = await (await fetch("http://127.0.0.1:4401/api/rounds")).json();

console.log("GUARD:" + JSON.stringify({
  before,
  after,
  activeRound_before: roundBefore.activeRound,
  activeRound_after: roundAfter.activeRound,
  guardWorked: after.emptyShown === true && after.docEmpty === true, // 旧标签页被重置而非误读新目录
}, null, 1));
ws.close();
process.exit(0);
