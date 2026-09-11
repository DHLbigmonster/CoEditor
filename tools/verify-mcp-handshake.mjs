// MCP stdio 握手验收：初始化 + 工具列表 + 真实读取一次约束。
// 用途：README 里「MCP stdio 服务在本地实测过握手与工具列表」这句话要有出处。
// 用法: node tools/verify-mcp-handshake.mjs [vault路径]
import { spawn } from "node:child_process";

const VAULT = process.argv[2] || "/tmp/coeditor-clean/sample";
const SERVER = process.argv[3] || "/tmp/coeditor-clean/mcp-stdio.mjs";

const child = spawn(process.execPath, [SERVER, VAULT], { stdio: ["pipe", "pipe", "pipe"] });
let buf = "";
const replies = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) replies.set(msg.id, msg);
    } catch { /* 非 JSON 行忽略 */ }
  }
});
let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const waitFor = async (id, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (replies.has(id)) return replies.get(id);
    await new Promise((r) => setTimeout(r, 80));
  }
  return null;
};

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail: detail == null ? "" : detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${JSON.stringify(detail).slice(0, 220)}` : ""}`);
};

try {
  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "coeditor-verify", version: "1" } } });
  const init = await waitFor(1);
  record("MCP initialize 有回包", Boolean(init && init.result), init && init.result && {
    protocolVersion: init.result.protocolVersion,
    serverInfo: init.result.serverInfo,
    capabilities: Object.keys(init.result.capabilities || {}),
  });

  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const tools = await waitFor(2);
  const names = tools && tools.result && tools.result.tools ? tools.result.tools.map((t) => t.name) : [];
  record("tools/list 返回工具清单", names.length > 0, `工具=${names.join(", ")}`);
  record("包含读取反馈的工具", names.some((n) => /get_review|list_documents/.test(n)), names.join(", "));

  // 真读一次：证明不是只有空壳协议
  const docArg = (process.env.MCP_DOC || "研究设计-英文摘要.pdf");
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_review", arguments: { doc: docArg } } });
  const call = await waitFor(3);
  const text = call && call.result && call.result.content ? String(call.result.content[0] && call.result.content[0].text || "") : "";
  record("get_review 能真读到内容", text.length > 0, text.replace(/\s+/g, " ").slice(0, 160));
  if (stderr.trim()) console.log("（stderr 摘要）", stderr.trim().slice(0, 200));
} catch (error) {
  record("握手过程无异常", false, String(error?.message || error));
} finally {
  child.kill();
  const pass = log.filter((l) => l.ok).length;
  console.log(`\nPASS ${pass} / FAIL ${log.length - pass}（共 ${log.length} 项）`);
  process.exit(pass === log.length ? 0 : 1);
}
