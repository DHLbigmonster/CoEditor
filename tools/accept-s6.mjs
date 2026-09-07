// S5 补充验收 10-14 + 验收 9 逐条断言（隔离副本 4461，合成数据）
// 验收 10-13：纯接口/进程级；验收 14 + 9：CDP 真实键鼠
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { writeFile as writeFileAsync } from "node:fs/promises";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = "http://127.0.0.1:4461";
const REPO = new URL('../', import.meta.url).pathname;
const VAULT = "/tmp/coeditor-u06";
const DOC = "验收10-14.md";
const out = {};

// 准备合成文档：三段
await writeFileAsync(`${VAULT}/${DOC}`, "# 验收文档\n\n第一段：这段保留句必须原样保留。\n\n第二段：这里有需要修改的表述。\n\n第三段：无关内容保持原样。\n");

// 建保留（第一段）+ 意见（第二段）
const post = async (path, body) => { const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
await post(`/api/annotations?p=${encodeURIComponent(DOC)}`, { kind: "highlight", quote: "这段保留句必须原样保留", prefix: "第一段：", suffix: "", body: "" });
await post(`/api/annotations?p=${encodeURIComponent(DOC)}`, { kind: "text", quote: "这里有需要修改的表述", prefix: "第二段：", suffix: "", body: "S6：改成更具体的表述" });

// ===== 验收 10：全新 mcp-stdio 会话（两次独立进程）持久发现 =====
const mcpCall = (name, args) => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, [`${REPO}mcp-stdio.mjs`, VAULT], { stdio: ["pipe", "pipe", "inherit"] });
  let o = "";
  proc.stdout.on("data", c => { o += c; });
  proc.on("close", () => {
    try { const line = o.split("\n").map(l => l.trim()).filter(Boolean).pop(); resolve(JSON.parse(line).result); }
    catch (e) { reject(e); }
  });
  proc.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
});
const call1 = await mcpCall("get_review", { doc: DOC });
const rev1 = JSON.parse(call1.content[0].text);
const call2 = await mcpCall("get_review", { doc: DOC });
const rev2 = JSON.parse(call2.content[0].text);
out.v10 = {
  coverageComplete: rev1.coverage?.complete === true,
  totals: rev1.coverage,
  pendingCount: rev1.pending.length,
  retainedCount: rev1.retained.length,
  defaultPolicyPresent: Boolean(rev1.defaultPolicy && rev1.defaultPolicy.includes("最小改动")),
  sessionsConsistent: rev1.pending.length === rev2.pending.length && rev1.retained.length === rev2.retained.length,
  pendingReadable: rev1.pending.some(p => (p.body || "").includes("S6")),
  retainedReadable: rev1.retained.some(r => r.quote.includes("这段保留句必须原样保留")),
};

// ===== 验收 11：越界改动 → 事后对照报警（当前保护等级：事前约束 + 事后报警，非拦截）=====
// 外部 Agent 直接写文件：改了第二段（合规）但意外删掉第一段保留句（越界）
const beforeText = await (await fetch(`${BASE}/api/doc?p=${encodeURIComponent(DOC)}`)).json();
const drifted = beforeText.text
  .replace("第一段：这段保留句必须原样保留。", "第一段：（保留句被越界改动删除）")
  .replace("这里有需要修改的表述", "这里改成了更具体的表述：样本文本");
await writeFileAsync(`${VAULT}/${DOC}`, drifted);
// 报警通道：版本对照的 retained 核对（diff 接口）
const diff = await (await fetch(`${BASE}/api/versions/diff?p=${encodeURIComponent(DOC)}&file=${encodeURIComponent(DOC)}`)).json();
out.v11 = {
  protectionLevel: "事后对照报警（非事前拦截）——普通外部 Agent 直接写文件只能检测不能阻止",
  retainedMissingReported: diff.retained && diff.retained.missing === 1,
  missingDetails: diff.retained,
  secondParagraphChanged: diff.diff && JSON.stringify(diff.diff.rows).includes("更具体的表述"),
  unrelatedParagraphIntact: !JSON.stringify(diff.diff.rows).includes("无关内容保持原样。") === false || diff.diff.rows.some(r => (r.text || "").includes("无关内容保持原样")),
};

// ===== 验收 12：保留跨三次改稿持续存在；resolve 不取消保留 =====
let retainedSurvived = true;
const resolveRounds = [];
for (let round = 1; round <= 3; round += 1) {
  // 每轮：Agent 建一条意见→处理→resolve（模拟一次改稿闭环）
  await post(`/api/annotations?p=${encodeURIComponent(DOC)}`, { kind: "text", quote: "第二段", prefix: "", suffix: "", body: `第 ${round} 轮改稿意见` });
  const l1 = (await (await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(DOC)}`)).json()).annotations || [];
  const todo = l1.find(a => a.kind === "text" && a.status === "active" && (a.body || "").includes(`第 ${round} 轮`));
  const res = await post(`/api/resolve?p=${encodeURIComponent(DOC)}`, { ids: [todo.no], versions: { [todo.no]: todo.version }, note: `第 ${round} 轮改稿` });
  const l2 = (await (await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(DOC)}`)).json()).annotations || [];
  const retainedNow = l2.filter(a => a.kind === "highlight" && a.status === "active").length;
  const skippedRetained = res.json.skipped?.some(s => s.reason === "retained-until-user-cancels");
  resolveRounds.push({ round, retainedActive: retainedNow, resolveRefusedRetained: skippedRetained || "（本轮未尝试 resolve 保留）" });
  if (retainedNow !== 1) retainedSurvived = false;
}
out.v12 = { rounds: resolveRounds, retainedSurvivedAllThree: retainedSurvived };

// ===== 验收 13：人手动更新保留句 → 不谎报 intact；旧版提交被 mtime 拦截；修订可追溯 =====
// （验收 11 已把保留句改掉——此刻 diff.retained.missing=1 即"不谎报 intact"已验证）
// 旧版提交：Agent 持有旧 mtime → /api/write 409
const staleDoc = await (await fetch(`${BASE}/api/doc?p=${encodeURIComponent(DOC)}`)).json();
const oldMtime = 1e12; // 明显过期的 mtime
const wres = await fetch(`${BASE}/api/write?p=${encodeURIComponent(DOC)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: beforeText.text, baseMtime: staleDoc.mtime === oldMtime ? Date.now() : oldMtime }) });
// 保留记录可追溯：highlight 的 history 与原 quote 仍在 sidecar
const anns = (await (await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(DOC)}`)).json()).annotations || [];
const retainedRec = anns.find(a => a.kind === "highlight");
out.v13 = {
  noFalseIntact: diff.retained && diff.retained.missing === 1,
  staleWriteRejected: wres.status === 409,
  retainedRecordTraceable: Boolean(retainedRec && retainedRec.quote.includes("这段保留句必须原样保留") && Array.isArray(retainedRec.history)),
  retainedStatus: retainedRec.status,
};

console.log("S6 验收（10-13 接口级）:", JSON.stringify(out, null, 1));
writeFileSync("/tmp/s6-interface.json", JSON.stringify(out, null, 1));
process.exit(0);
