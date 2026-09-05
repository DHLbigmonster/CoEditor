// 版本对照闭环 E2E：登记 → 列表 → diff → 验收 → 继续批注新版本
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { mkdtemp, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-versions-vault";

// 原文 + 新版本（Agent 产出，放在旁边）
await mkdir(VAULT, { recursive: true });
await writeFile(join(VAULT, "茶事方案.md"), "# 春季上新\n\n先读这一段。\n\n把预算花在原料和第一次体验上。\n");
await writeFile(join(VAULT, "茶事方案-v2.md"), "# 春季上新\n\n先读这一段。\n\n把预算花在原料、包装和第一次体验上，让产品成为被记住的理由。\n\n补充：上线两周后同时看试饮转化与复购。\n");

const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").includes("4401"));
if (!page) { page = await (await fetch(`http://127.0.0.1:9333/json/new?${BASE}`, { method: "PUT" })).json(); }
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pm = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const k = ++id; pm.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method: m, params: p })); });
ws.on("message", (d) => { const m = JSON.parse(d); if (m.id && pm.has(m.id)) { const p = pm.get(m.id); pm.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
await new Promise((r) => ws.on("open", r));
const evalv = async (expr) => {
  const ev = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (ev.exceptionDetails) throw new Error("eval: " + JSON.stringify(ev.exceptionDetails.exception || ev.exceptionDetails).slice(0, 300));
  return ev.result ? ev.result.value : undefined;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = {};

// ① API 登记（模拟 Agent 调 register_version）
const reg = await (await fetch(`${BASE}/api/versions?p=` + encodeURIComponent("茶事方案.md"), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "register", file: "茶事方案-v2.md", note: "补充复购指标" }),
})).json();
result.registered = reg.ok === true;

// ② 拒绝登记「与原件相同」的文件
const dup = await (await fetch(`${BASE}/api/versions?p=` + encodeURIComponent("茶事方案.md"), {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ action: "register", file: "茶事方案.md" }),
})).json();
result.dupRejected = !!dup.error;

// ③ 前端：打开文档 → 切「版本对照」Tab → 列表 + diff 渲染
await send("Page.navigate", { url: `${BASE}/?doc=` + encodeURIComponent("茶事方案.md") });
await sleep(2400);
await evalv(`(() => { const tab = document.querySelector('[data-feedback="versions"]'); if (tab) tab.click(); return !!tab; })()`);
await sleep(900);
result.ui = await evalv(`(() => {
  const panel = document.querySelector("#cards .version-panel");
  const items = [...document.querySelectorAll("#cards .vp-item")];
  return {
    panelShown: !!panel,
    listCount: items.length,
    firstFile: (items[0] && items[0].querySelector(".vp-file") || {}).textContent || "",
    status: (items[0] && items[0].querySelector(".vp-status") || {}).textContent || "",
  };
})()`);
// diff 已自动加载
result.diff = await evalv(`(() => {
  const rows = [...document.querySelectorAll("#cards .vp-row")];
  return { rowCount: rows.length, addedShown: rows.some((r) => r.classList.contains("added")), removedShown: rows.some((r) => r.classList.contains("removed")) };
})()`);

// ④ 验收
await evalv(`(() => { document.getElementById("vp-accept").click(); return 1; })()`);
let accepted = null;
for (let i = 0; i < 12; i += 1) {
  accepted = await evalv(`(() => {
    const st = document.querySelector("#cards .vp-status");
    return st ? st.dataset.status : null;
  })()`);
  if (accepted === "accepted") break;
  await sleep(400);
}
result.accepted = accepted;

// ⑤ 继续批注新版本
await evalv(`(() => { document.getElementById("vp-open").click(); return 1; })()`);
await sleep(1500);
result.openedNewVersion = await evalv(`decodeURIComponent(location.search.replace("?doc=", "")).includes("茶事方案-v2")`);

console.log("VERSIONS:" + JSON.stringify(result, null, 1));
ws.close(); process.exit(0);
