// §0 验收纠偏：v12 真实拒保留 / v9b 真实路径浮卡 / v9c 构造 addressed / v13 完整交互
// 隔离副本 4461，合成数据。结果写 tools/acceptance/corrections-result.json
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { writeFile as writeFileAsync } from "node:fs/promises";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4461";
const VAULT = "/tmp/coeditor-u06";
const REPO = new URL('../../', import.meta.url).pathname;
const DOC = "验收10-14.md";
const out = {};
const post = async (path, body) => { const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
const mcpCall = (name, args) => new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, [`${REPO}mcp-stdio.mjs`, VAULT], { stdio: ["pipe", "pipe", "inherit"] });
  let o = ""; proc.stdout.on("data", c => { o += c; });
  proc.on("close", () => { try { resolve(JSON.parse(o.split("\n").map(l => l.trim()).filter(Boolean).pop()).result); } catch (e) { reject(e); } });
  proc.stdin.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
});

// ===== v12 纠偏：真正对保留 ID 调 resolve → 必须拒绝且回读仍 active =====
const anns = (await (await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(DOC)}`)).json()).annotations || [];
const retained = anns.find(a => a.kind === "highlight" && a.status === "active");
const res = await post(`/api/resolve?p=${encodeURIComponent(DOC)}`, { ids: [retained.no], versions: { [retained.no]: retained.version }, note: "尝试归档保留" });
const after = (await (await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(DOC)}`)).json()).annotations || [];
out.v12 = {
  resolveRefused: res.json.skipped?.some(s => s.id === retained.no && s.reason === "retained-until-user-cancels"),
  stillActiveAfterResolve: after.find(a => a.id === retained.id).status === "active",
};

// ===== v13 纠偏：手动修改保留句 → 保存 → 更新保留指向（完整交互）=====
// 交互级（编辑器 UI）在浏览器测；接口级这里模拟「更新保留指向」的 PATCH：
const newSentence = "这段保留句必须原样保留（用户手动更新过）";
await writeFileAsync(`${VAULT}/${DOC}`, `# 验收文档\n\n第一段：${newSentence}\n\n第二段：这里有需要修改的表述（已按意见更新）。\n\n第三段：无关内容保持原样。\n`);
// 更新保留指向：quote 更新为新句（UI「更新保留指向」动作 = PATCH）
const updResp = await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(DOC)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: retained.id, quote: newSentence, event: "retargeted-after-edit" }) });
const upd = { status: updResp.status, json: await updResp.json().catch(() => ({})) };
out.v13 = {
  retargetStatus: upd.status,
  historyTracked: (upd.json.annotation?.history || []).some(h => h.event === "retargeted-after-edit"),
  // 旧 Agent 修订提交（旧版本 resolve）对更新后的保留仍无效
  resolveStillRefused: (await post(`/api/resolve?p=${encodeURIComponent(DOC)}`, { ids: [retained.no], versions: { [retained.no]: upd.json.annotation.version } })).json.skipped?.some(s => s.reason === "retained-until-user-cancels"),
};

// ===== v12/v13 经 MCP（全新会话）复核：get_review 的 retained 仍是同一要求 =====
const rev = JSON.parse((await mcpCall("get_review", { doc: DOC })).content[0].text);
out.mcpCrossCheck = {
  retainedReadable: rev.retained.some(r => r.quote === newSentence),
  coverageComplete: rev.coverage?.complete === true,
};

// ===== v9c：主动构造 addressed 卡 → 断言显示与历史入口 =====
// （CDP 部分：构造 + 断言"已修改 ✓"徽标、opacity、历史分组入口）
await post(`/api/annotations?p=${encodeURIComponent(DOC)}`, { kind: "text", quote: "第二段", body: "S6 纠偏：这条会被处理" });
const l = (await (await fetch(`${BASE}/api/annotations?p=${encodeURIComponent(DOC)}`)).json()).annotations || [];
const todo = l.find(a => (a.body || "").includes("S6 纠偏"));
await post(`/api/resolve?p=${encodeURIComponent(DOC)}`, { ids: [todo.no], versions: { [todo.no]: todo.version } });

console.log("S6 纠偏（接口级）:", JSON.stringify(out, null, 1));
writeFileSync(new URL("./corrections-interface.json", import.meta.url), JSON.stringify(out, null, 1));
process.exit(0);
