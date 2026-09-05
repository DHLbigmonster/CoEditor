// 版本对照闭环 E2E（v0.9.10 重做）：不可再「功能坏了也能通过」。
// 覆盖：登记幂等 / 同文件多路径拒绝 / 按 id 验收不验收错对象 / 内容漂移拒绝验收 /
//       顺序敏感 diff（段落重排必须被发现）/ 服务端保留继承（幂等 + 缺失报警）/ UI 真实跳转
// 本套件只动自己的子目录（电池共享 vault，绝不清别人的文档与批注）。
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-versions-vault";
const SUB = "版本对照测试";
const P = (name) => `${SUB}/${name}`;
const DOC = P("茶事方案.md");

// 套件自带全新子目录 + 清掉 sidecar 里自己的旧状态：登记/验收状态是断言的一部分，
// 残留的上一轮状态会让断言失真。绝不触碰 vault 里其他文档。
await rm(join(VAULT, SUB), { recursive: true, force: true });
await mkdir(join(VAULT, SUB), { recursive: true });
try {
  const sidecarPath = join(VAULT, ".marginalia", "annotations.json");
  const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
  for (const key of ["docs", "versions", "docRounds", "counters"]) {
    if (sidecar[key]) for (const k of Object.keys(sidecar[key])) if (k.startsWith(`${SUB}/`)) delete sidecar[key][k];
  }
  if (Array.isArray(sidecar.roundHistory)) sidecar.roundHistory = sidecar.roundHistory.filter(e => !(e.doc || "").startsWith(`${SUB}/`));
  sidecar.revision = (sidecar.revision || 0) + 1;
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));
} catch { /* sidecar 尚不存在 = 干净环境 */ }

await writeFile(join(VAULT, P("茶事方案.md")), "# 春季上新\n\n先读这一段。\n\n把预算花在原料和第一次体验上。\n");
await writeFile(join(VAULT, P("茶事方案-v2.md")), "# 春季上新\n\n先读这一段。\n\n把预算花在原料、包装和第一次体验上，让产品成为被记住的理由。\n\n补充：上线两周后同时看试饮转化与复购。\n");
await writeFile(join(VAULT, P("茶事方案-v3.md")), "# 春季上新\n\n先读这一段。\n\n把预算花在原料、包装和第一次体验上，让产品成为被记住的理由。\n\n补充：上线两周后同时看试饮转化与复购。\n\n新增：与门店联名做主题杯。\n");
await writeFile(join(VAULT, P("顺序测试.md")), "# 重排\n\n第一段，讲原料。\n\n第二段，讲包装。\n");
await writeFile(join(VAULT, P("顺序测试-v2.md")), "# 重排\n\n第二段，讲包装。\n\n第一段，讲原料。\n");
await writeFile(join(VAULT, P("缺失测试.md")), "# 报告\n\n这段必须保留。\n\n其他内容。\n");
await writeFile(join(VAULT, P("缺失测试-v2.md")), "# 报告\n\n完全不同的内容，保留的原文已经不在。\n");

const post = async (path, body) => {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
const getVersions = async (doc) => (await (await fetch(`${BASE}/api/versions?p=${encodeURIComponent(doc)}`)).json()).versions || [];
const getAnnotations = async (doc) => (await (await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(doc)}`)).json()).annotations || [];
const result = {};

/* ---- A1. 原文建「保留」标注（后续继承与缺失场景的源头） ---- */
await post(`/api/annotations?p=${encodeURIComponent(DOC)}`, { kind: "highlight", quote: "先读这一段", prefix: "", suffix: "", body: "这句开场白不能动" });

/* ---- A2. 登记 v2：必须拿到不可变 id + 内容哈希 + 快照 ---- */
const reg = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "register", file: P("茶事方案-v2.md"), note: "补充复购指标" });
result.registered = reg.json.ok === true;
result.hasIdAndHash = Boolean(reg.json.version && /^v-/.test(reg.json.version.id || "") && reg.json.version.nextHash);
const v2id = reg.json.version && reg.json.version.id;
result.snapshotSaved = Boolean(reg.json.version && reg.json.version.snapshot && await readFile(join(VAULT, reg.json.version.snapshot.next)).then(() => true).catch(() => false));

/* ---- A3. 与原件相同的文件必须拒绝：直接同名 + ./ 相对路径写法 ---- */
const dup = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "register", file: DOC });
const dupDot = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "register", file: `${SUB}/./茶事方案.md` });
result.dupRejected = !!dup.json.error;
result.sameFileRejected = !!dupDot.json.error;

/* ---- A4. 同内容重复登记 = 幂等：不堆叠、不重置状态 ---- */
const before = await getVersions(DOC);
await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "register", file: P("茶事方案-v2.md"), note: "重复登记" });
const after = await getVersions(DOC);
result.idempotentRegister = before.length === after.length && after.filter(v => v.id === v2id).length === 1;

/* ---- A5. 验收错位复现：用户视图停在 v2 → Agent 又登记 v3 → 用户点验收 → 验收的必须是 v2 ---- */
await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "decide", id: v2id, status: "accepted" });
await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "register", file: P("茶事方案-v3.md"), note: "联名主题杯" });
const list5 = await getVersions(DOC);
const v2Entry = list5.find(v => v.id === v2id);
const v3Entry = list5.find(v => v.file === P("茶事方案-v3.md"));
result.acceptedRightVersion = v2Entry && v2Entry.status === "accepted" && v3Entry && v3Entry.status === "pending";

/* ---- A6. 内容漂移：改掉 v3 文件再验收 → 必须被拒绝且状态不变 ---- */
const v3idOld = v3Entry.id;
await writeFile(join(VAULT, P("茶事方案-v3.md")), (await readFile(join(VAULT, P("茶事方案-v3.md")), "utf8")) + "\n版本备注：登记后内容被改过。\n");
const drift = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "decide", id: v3idOld, status: "accepted" });
const list6 = await getVersions(DOC);
result.driftBlocked = drift.status === 409 && drift.json.error === "version-content-changed" && list6.find(v => v.id === v3idOld).status === "pending";

/* ---- A7. 内容变化后的重新登记 = 新条目（旧登记保留历史），新条目可正常验收 ---- */
const reReg = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "register", file: P("茶事方案-v3.md"), note: "内容更新后重新登记" });
const v3idNew = reReg.json.version && reReg.json.version.id;
result.driftCreatesNewEntry = Boolean(v3idNew && v3idNew !== v3idOld);
const reDecide = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "decide", id: v3idNew, status: "accepted" });
result.reDecideOk = reDecide.status === 200;

/* ---- A8. 顺序敏感 diff：段落重排必须显示为「删旧 + 增新」，不得抹成毫无变化 ---- */
await post(`/api/versions?p=${encodeURIComponent(P("顺序测试.md"))}`, { action: "register", file: P("顺序测试-v2.md") });
const reorder = await (await fetch(`${BASE}/api/versions/diff?p=${encodeURIComponent(P("顺序测试.md"))}&file=${encodeURIComponent(P("顺序测试-v2.md"))}`)).json();
result.reorderDetected = Boolean(reorder.diff && reorder.diff.orderAware && reorder.diff.summary.added === 1 && reorder.diff.summary.removed === 1);

/* ---- A9. 服务端保留继承：继承 → 幂等 → 原文缺失报警 ---- */
const carry1 = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "carry", to: P("茶事方案-v3.md") });
const anns3 = await getAnnotations(P("茶事方案-v3.md"));
const carriedAnns = anns3.filter(a => a.carriedFrom);
result.carryOnce = carry1.json.ok === true && carriedAnns.length === 1 && carriedAnns[0].quote === "先读这一段" && carriedAnns[0].body === "这句开场白不能动";
const carry2 = await post(`/api/versions?p=${encodeURIComponent(DOC)}`, { action: "carry", to: P("茶事方案-v3.md") });
result.carryIdempotent = carry2.json.ok === true && carry2.json.carried.length === 0 && carry2.json.skipped.length === 1 && (await getAnnotations(P("茶事方案-v3.md"))).length === anns3.length;
await post(`/api/annotations?p=${encodeURIComponent(P("缺失测试.md"))}`, { kind: "highlight", quote: "这段必须保留", prefix: "", suffix: "", body: "不可删除" });
const carry3 = await post(`/api/versions?p=${encodeURIComponent(P("缺失测试.md"))}`, { action: "carry", to: P("缺失测试-v2.md") });
const missingAnns = (await getAnnotations(P("缺失测试-v2.md"))).filter(a => a.carriedFrom);
result.carryMissingFlagged = carry3.json.ok === true && carry3.json.missing.length === 1 && missingAnns.length === 1 && missingAnns[0].anchorStatus === "missing" && (missingAnns[0].body || "").includes("保留内容缺失");

/* ---- A10. diff 汇总：回应了几条反馈 + 保留内容是否完好 ---- */
const sumDiff = await (await fetch(`${BASE}/api/versions/diff?p=${encodeURIComponent(P("缺失测试.md"))}&file=${encodeURIComponent(P("缺失测试-v2.md"))}`)).json();
result.diffReport = sumDiff.retained && sumDiff.retained.total === 1 && sumDiff.retained.missing === 1 && typeof sumDiff.responded === "number";

/* ---- A11. 退回版本 → Agent 已处理的批注重新待处理、批次回退 ---- */
await post(`/api/annotations?p=${encodeURIComponent(P("顺序测试.md"))}`, { kind: "text", quote: "第一段，讲原料", body: "退回测试：这条要改" });
const annSeq = (await getAnnotations(P("顺序测试.md"))).find(a => a.kind === "text");
await post(`/api/resolve?p=${encodeURIComponent(P("顺序测试.md"))}`, { ids: [annSeq.no], versions: { [annSeq.no]: annSeq.version } });
const resolvedNow = (await getAnnotations(P("顺序测试.md"))).find(a => a.id === annSeq.id);
const roundAfterResolve = (await (await fetch(`${BASE}/api/rounds?p=${encodeURIComponent(P("顺序测试.md"))}`)).json()).activeRound;
await post(`/api/versions?p=${encodeURIComponent(P("顺序测试.md"))}`, { action: "register", file: P("顺序测试-v2.md"), note: "退回场景" });
const rejList = await getVersions(P("顺序测试.md"));
const rejEntry = rejList.find(v => v.file === P("顺序测试-v2.md"));
const rej = await post(`/api/versions?p=${encodeURIComponent(P("顺序测试.md"))}`, { action: "decide", id: rejEntry.id, status: "rejected" });
const reopenedAnn = (await getAnnotations(P("顺序测试.md"))).find(a => a.id === annSeq.id);
const roundAfterReject = (await (await fetch(`${BASE}/api/rounds?p=${encodeURIComponent(P("顺序测试.md"))}`)).json()).activeRound;
result.rejectedReopens = rej.json.ok === true && Array.isArray(rej.json.reopened) && rej.json.reopened.includes(annSeq.no)
  && resolvedNow.status === "addressed" && reopenedAnn.status === "active"
  && roundAfterReject === Math.max(0, (Number(roundAfterResolve) || 0) - 1);

/* ---- B. UI：面板 / 未变化措辞 / 漂移黄条 / 验收落在本尊 / 真实跳转且保留已继承 ----
   UI 层用干净的「验收错位测试」文档，完整复现报告场景：
   用户看到 v2 → Agent 又登记新版本（列表移位）→ 用户点验收 → 被验收的必须是用户看到的那个 */
await writeFile(join(VAULT, P("验收错位测试.md")), "# 验收错位\n\n开场白不能动。\n\n正文一。\n");
await writeFile(join(VAULT, P("验收错位测试-v2.md")), "# 验收错位\n\n开场白不能动。\n\n正文一改。\n\n新增段落。\n");
await writeFile(join(VAULT, P("验收错位测试-v4.md")), "# 验收错位\n\n开场白不能动。\n\n正文一改。\n\n新增段落。\n\n再补一段。\n");
await post(`/api/annotations?p=${encodeURIComponent(P("验收错位测试.md"))}`, { kind: "highlight", quote: "开场白不能动", prefix: "", suffix: "", body: "不可动" });
const uiReg = await post(`/api/versions?p=${encodeURIComponent(P("验收错位测试.md"))}`, { action: "register", file: P("验收错位测试-v2.md"), note: "UI 验收对象" });
const uiIdA = uiReg.json.version && uiReg.json.version.id;

const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((t) => t.type === "page" && (t.url || "").startsWith(BASE));
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
const openVersionsTab = `(() => {
  const pending = document.querySelector('[data-feedback="pending"]');
  if (pending) pending.click();
  const tab = document.querySelector('[data-feedback="versions"]');
  if (tab) tab.click();
  return !!tab;
})()`;

await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(P("验收错位测试.md"))}` });
await sleep(2400);
await evalv(openVersionsTab);
await sleep(1200);
result.panelShown = await evalv(`!!document.querySelector("#cards .version-panel .vp-list")`);
// 愿景图头部：回应汇总 + 保留状态（该文档 1 条保留且原文在新稿中 → 未改动）
result.reportShown = await evalv(`(() => {
  const r = document.querySelector("#cards .vp-report");
  return r ? r.textContent.includes("1 处保留内容未改动") : false;
})()`);
// 并排双栏（默认视图）：左右两列 + 未变化折叠可展开
result.unchangedWording = await evalv(`(() => {
  const s = document.querySelector("#cards .vp-summary");
  return s ? (s.textContent.includes("未变化") && !s.textContent.includes("保留 ")) : false;
})()`) && await evalv(`(async () => {
  const gap = document.querySelector("#cards .sb-gap");
  if (!gap) return !!document.querySelector("#cards .sb-row.same");
  gap.click();
  await new Promise(r => setTimeout(r, 200));
  return document.querySelectorAll("#cards .sb-row.same").length > 0;
})()`);

// B1. 漂移黄条：登记后文件被改 → 对照顶部必须明示「与登记时不一致」（读改写 = 重跑也真漂移）
await writeFile(join(VAULT, P("验收错位测试-v2.md")), (await readFile(join(VAULT, P("验收错位测试-v2.md")), "utf8")) + "\n登记之后偷偷加的一段。\n");
await evalv(`(() => { const b = document.querySelector("#cards .vp-item"); if (b) b.click(); return 1; })()`);
await sleep(1100);
result.driftWarned = await evalv(`!!document.querySelector("#cards .vp-changed")`);

// B2. 验收落在本尊：重新登记（内容变后的 idB）→ 再登记 v4 干扰（UI 未刷新）→ 点验收
//     → 被验收的必须是 UI 选中的 idB，v4 必须仍是 pending
const uiReReg = await post(`/api/versions?p=${encodeURIComponent(P("验收错位测试.md"))}`, { action: "register", file: P("验收错位测试-v2.md"), note: "内容更新后重新登记" });
const uiIdB = uiReReg.json.version && uiReReg.json.version.id;
await post(`/api/versions?p=${encodeURIComponent(P("验收错位测试.md"))}`, { action: "register", file: P("验收错位测试-v4.md"), note: "干扰项：登记时 UI 未刷新" });
const acceptedBefore = (await getVersions(P("验收错位测试.md"))).filter(v => v.status === "accepted").length;
await evalv(openVersionsTab);
await sleep(1200);
// 显式点选 idB（内容变化后重新登记的那条）：用户的「所见」就是这条
const picked = await evalv(`(() => {
  const b = document.querySelector('#cards .vp-item[data-vp-id="${uiIdB}"]');
  if (!b) return false;
  b.click();
  return true;
})()`);
await sleep(1000);
const uiActiveId = await evalv(`(() => { const a = document.querySelector("#cards .vp-item.active"); return a ? a.dataset.vpId : ""; })()`);
await evalv(`(() => { const b = document.querySelector("#cards .vp-accept"); if (b) b.click(); return 1; })()`);
await sleep(1300);
const uiList = await getVersions(P("验收错位测试.md"));
result.uiAcceptedRightVersion = picked && uiActiveId === uiIdB
  && uiList.find(v => v.id === uiIdB).status === "accepted"
  && uiList.find(v => v.file === P("验收错位测试-v4.md")).status === "pending"
  && uiList.filter(v => v.status === "accepted").length === acceptedBefore + 1;

// B3. 真实跳转：继续批注新版本 → URL 真的变了，保留标记已继承在（服务端幂等路径）
await evalv(`(() => { const b = document.querySelector("#cards .vp-open"); if (b) b.click(); return 1; })()`);
let openedNewVersion = false, carriedRetained = 0;
for (let i = 0; i < 20; i += 1) {
  const loc = await evalv(`decodeURIComponent(location.search.replace("?doc=", ""))`);
  carriedRetained = await evalv(`document.querySelectorAll('#doc .anchor[data-kind="highlight"]').length`) || 0;
  if (loc.includes("验收错位测试-v2") && carriedRetained > 0) { openedNewVersion = true; break; }
  await sleep(500);
}
result.openedNewVersion = openedNewVersion;
result.carriedRetained = carriedRetained;

// 清理：-v2 上继承来的批注删掉（保持套件幂等；登记与验收状态是真实历史，保留）
await evalv(`(async () => {
  const list = (await (await fetch('/api/annotations?p=' + encodeURIComponent(${JSON.stringify(P("验收错位测试-v2.md"))}))).json()).annotations || [];
  for (const a of list) {
    if (a.kind === 'highlight') {
      await fetch('/api/annotations?p=' + encodeURIComponent(${JSON.stringify(P("验收错位测试-v2.md"))}), {
        method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: a.id }),
      });
    }
  }
  return true;
})()`);

console.log("VERSIONS:" + JSON.stringify(result, null, 1));
ws.close(); process.exit(0);
