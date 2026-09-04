#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const [command, ...rest] = process.argv.slice(2);

const help = `CoEditor CLI

  open <folder> [--port 4400]      启动本地批注层网页服务
  constraints <folder> <doc>       输出该文档当前使用的约束批注（给 Agent 用）
  constraints --json <folder> <doc> 以 JSON 输出
  conflicts <folder> <doc>         列出尚未裁定的冲突批注
  canvas <folder> <doc>            导出 Obsidian JSON Canvas（<doc>.canvas，含批注卡与连线）
  mcp <folder>                     以 stdio 启动 MCP server（供 claude mcp add 使用）

接入 MCP：
  claude mcp add coeditor -- node ${join(HERE, "mcp-stdio.mjs")} <vault 绝对路径>

示例：
  node cli.mjs open ~/Documents/thesis
  node cli.mjs constraints ~/Documents/thesis ch3.md
`;

async function readDoc(folder, doc) {
  const sidecar = join(resolve(folder), ".marginalia", "annotations.json");
  try {
    const data = JSON.parse(await readFile(sidecar, "utf8"));
    const list = data.docs[doc] || [];
    const usedByRound = new Map();
    for (const item of list) {
      const round = Number.isFinite(item.round) ? item.round : 0;
      if (!usedByRound.has(round)) usedByRound.set(round, new Set());
      const match = typeof item.no === "string" ? /^(\d+)-(\d+)$/.exec(item.no) : null;
      if (match && Number(match[1]) === round) usedByRound.get(round).add(Number(match[2]));
    }
    for (const item of list) {
      const round = Number.isFinite(item.round) ? item.round : 0;
      if (typeof item.no === "string" && new RegExp(`^${round}-\\d+$`).test(item.no)) continue;
      let seq = 1; while (usedByRound.get(round).has(seq)) seq += 1;
      usedByRound.get(round).add(seq); item.no = `${round}-${seq}`;
    }
    return list;
  } catch {
    return [];
  }
}

async function constraints(folder, doc, flags) {
  const list = await readDoc(folder, doc);
  const active = list.filter((item) => item.status === "active").sort((a, b) => b.weight - a.weight);
  if (flags.json) {
    console.log(JSON.stringify({ doc, count: active.length, constraints: active }, null, 2));
    return;
  }
  const noOf = (itemOrId) => {
    const item = typeof itemOrId === "string" ? list.find((entry) => entry.id === itemOrId) : itemOrId;
    return item ? (item.no || item.id) : itemOrId;
  };
  console.log(`# ${doc} · 当前批注 ${active.length} 条`);
  for (const item of active) {
    // 冲突警告只算对方仍生效的：对方已 deprecated 即冲突已解除（与 conflicts 命令口径一致）
    const liveConflicts = (item.conflicts_with || []).filter((id) => {
      const other = list.find((entry) => entry.id === id);
      return other && other.status === "active";
    });
    const conflict = liveConflicts.length ? `  ⚠ 与 ${liveConflicts.map(noOf).join("/")} 冲突` : "";
    console.log(`\n[${noOf(item)}] w=${Number(item.weight ?? 1).toFixed(2)}${conflict}`);
    console.log(`  位置：「${item.quote.slice(0, 60)}」`);
    console.log(`  要求：${item.body}`);
  }
}

async function conflicts(folder, doc) {
  const list = await readDoc(folder, doc);
  const active = list.filter((item) => item.status === "active" && (item.conflicts_with || []).length);
  if (!active.length) return console.log("（无未裁定冲突）");
  const seen = new Set();
  for (const item of active) {
    for (const other of item.conflicts_with) {
      const pair = [item.id, other].sort().join("~");
      if (seen.has(pair)) continue;
      seen.add(pair);
      const a = list.find((entry) => entry.id === item.id);
      const b = list.find((entry) => entry.id === other);
      if (!a || !b || a.status !== "active" || b.status !== "active") continue;
      const aNo = a.no || a.id; const bNo = b.no || b.id;
      console.log(`\n⚠ ${aNo} × ${bNo}`);
      console.log(`  ${aNo}：「${a.quote.slice(0, 50)}」→ ${a.body}`);
      console.log(`  ${bNo}：「${b.quote.slice(0, 50)}」→ ${b.body}`);
      console.log(`  （在网页中点「以此为准」裁定）`);
    }
  }
}

/* ---------------- Obsidian JSON Canvas 导出（第二宿主的核心渲染器） ---------------- */
const CANVAS_COLOR = { active: "1", addressed: "4", stale: "3", deprecated: "#7d7a75" };

async function exportCanvas(folder, doc) {
  const root = resolve(folder);
  const list = await readDoc(root, doc);
  const nodes = [{
    id: "doc",
    type: "file",
    file: doc,
    x: 0,
    y: 0,
    width: 560,
    height: 720,
  }];
  const edges = [];
  let y = 0;
  for (const item of list) {
    const conflicts = (item.conflicts_with || []).length ? `\n> [!warning] 与 ${item.conflicts_with.join(" / ")} 冲突，待裁定` : "";
    const superseded = (item.supersedes || []).length ? `\n> 替代 ${item.supersedes.join(" / ")}` : "";
    const anchor = item.region
      ? `${item.region.page ? `第 ${item.region.page} 页 ` : ""}区域 (${item.region.x.toFixed(2)}, ${item.region.y.toFixed(2)})${item.image ? ` · ${item.image}` : ""}`
      : `「${item.quote.slice(0, 80)}」`;
    nodes.push({
      id: item.id,
      type: "text",
      text: `**${item.no || item.id}** · ${item.status} · w=${Number(item.weight ?? 1).toFixed(2)}\n\n${item.body}\n\n---\n锚点：${anchor}${conflicts}${superseded}`,
      x: 760,
      y,
      width: 360,
      height: 200,
      color: CANVAS_COLOR[item.status] || "#7d7a75",
    });
    edges.push({
      id: `e-${item.id}`,
      fromNode: "doc",
      fromSide: "right",
      toNode: item.id,
      toSide: "left",
      label: `${item.no || item.id} ${item.status}`,
      color: CANVAS_COLOR[item.status] || "#7d7a75",
    });
    y += 240;
  }
  const target = join(root, `${doc}.canvas`);
  await writeFile(target, JSON.stringify({ nodes, edges }, null, 2));
  console.log(`已导出 ${target}（${list.length} 张批注卡）—— 用 Obsidian 打开此 vault 即可查看`);
}

/* canvas --with-canvas：连同手绘箭头标签一起导出（画布元素按文档归属）。
   旧版便签数据仍保留在 sidecar，但产品已停止呈现和导出。 */
async function exportCanvasFull(folder, doc) {
  const root = resolve(folder);
  await exportCanvas(root, doc);
  const sidecarPath = join(root, ".marginalia", "annotations.json");
  let canvasEls = { arrows: [] };
  try {
    const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
    const owns = (item) => !item.doc || item.doc === doc;
    canvasEls.arrows = (sidecar.arrows || []).filter((a) => owns(a) && (a.label || "").trim());
  } catch {
    return;
  }
  if (!canvasEls.arrows.length) return;
  const target = join(root, `${doc}.canvas`);
  const data = JSON.parse(await readFile(target, "utf8"));
  let y = 0;
  for (const arrow of canvasEls.arrows) {
    data.nodes.push({
      id: arrow.id,
      type: "text",
      text: `**${arrow.id}** · 箭头标签（${arrow.color}）\n\n「${arrow.label.trim()}」`,
      x: 1200,
      y,
      width: 280,
      height: 120,
      color: "2",
    });
    y += 160;
  }
  await writeFile(target, JSON.stringify(data, null, 2));
  console.log(`画布元素：${canvasEls.arrows.length} 个箭头标签已并入`);
}

if (command === "open") {
  const folder = rest[0] || process.cwd();
  const portIndex = rest.indexOf("--port");
  const port = portIndex >= 0 ? rest[portIndex + 1] : "4400";
  spawn(process.execPath, [join(HERE, "server.mjs"), resolve(folder)], {
    stdio: "inherit",
    env: { ...process.env, COEDITOR_PORT: port },
  });
} else if (command === "constraints") {
  const flags = { json: rest.includes("--json") };
  const args = rest.filter((item) => item !== "--json");
  await constraints(args[0] || process.cwd(), args[1], flags);
} else if (command === "conflicts") {
  await conflicts(rest[0] || process.cwd(), rest[1]);
} else if (command === "canvas") {
  if (!rest[1]) {
    console.log("用法：canvas <folder> <doc>");
  } else {
    await exportCanvasFull(rest[0], rest[1]);
  }
} else if (command === "mcp") {
  spawn(process.execPath, [join(HERE, "mcp-stdio.mjs"), resolve(rest[0] || process.cwd())], { stdio: "inherit" });
} else {
  console.log(help);
}
