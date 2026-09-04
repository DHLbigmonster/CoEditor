#!/usr/bin/env node
// CoEditor MCP stdio server —— 零依赖手写 JSON-RPC 2.0
// 接入：claude mcp add coeditor -- node /abs/path/mcp-stdio.mjs /abs/vault
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(process.argv[2] || process.cwd());
const SIDECAR = join(ROOT, ".marginalia", "annotations.json");
const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".html", ".htm", ".json", ".csv"]);
const VIEW_EXT = new Set([...TEXT_EXT, ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);

function safeResolve(relPath) {
  const target = resolve(ROOT, relPath || "");
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

async function listTree(dir = ROOT, base = ROOT) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const rel = relative(base, full);
    if (entry.isDirectory()) out.push(...(await listTree(full, base)));
    else if (VIEW_EXT.has(extname(entry.name).toLowerCase())) out.push(rel);
  }
  return out.sort();
}

async function loadAnnotations(doc) {
  try {
    const data = JSON.parse(await readFile(SIDECAR, "utf8"));
    return data.docs[doc] || [];
  } catch {
    return [];
  }
}

const TOOLS = [
  {
    name: "list_documents",
    description: "列出 CoEditor 库中所有可批注的文档（相对路径）",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_document",
    description: "读取指定文档的全文内容",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string", description: "文档相对路径" } },
      required: ["doc"],
    },
  },
  {
    name: "list_annotations",
    description: "列出指定文档的全部批注（含已过期/废弃，含编号、状态、权重、历史）",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string", description: "文档相对路径" } },
      required: ["doc"],
    },
  },
  {
    name: "get_active_constraints",
    description:
      "【修改文档前必调】获取指定文档当前生效的人类批注约束，按权重降序。任何对该文档的修改都必须先遵守这些约束；无法满足时应向用户说明而不是绕过。",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string", description: "文档相对路径" } },
      required: ["doc"],
    },
  },
  {
    name: "get_annotation_context",
    description: "读取单条批注的完整详情（含冲突与替代关系）",
    inputSchema: {
      type: "object",
      properties: {
        doc: { type: "string" },
        id: { type: "string", description: "批注编号，如 A-0003" },
      },
      required: ["doc", "id"],
    },
  },
  {
    name: "list_annotation_exports",
    description:
      "列出已导出的标注截图（.marginalia/exports/ 中的文件绝对路径）。图片文档的批注导出后，用此工具取图，再按批注要求改图。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "insert_asset",
    description:
      "把生成的产物（新版本图片/文本片段）写入 CoEditor 库。遵守 Cowart 哲学：新产物放旁边，永不覆盖原件。返回文件在网页中的相对路径；人刷新文件树即可看到。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "文件名（可含一层子目录，越界与特殊字符会被消毒）" },
        content_base64: { type: "string", description: "文件内容（base64），二进制图片用这个" },
        content_text: { type: "string", description: "文件内容（utf8 文本），md/html/txt 用这个" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_canvas_state",
    description:
      "读取画布全貌：手绘箭头、便签、图卡、HTML 草稿卡（含坐标与归属文档）。修改前了解人在画布上的视觉语境时调用。",
    inputSchema: {
      type: "object",
      properties: { doc: { type: "string", description: "可选：只看归属某文档的元素" } },
    },
  },
  {
    name: "get_ui_state",
    description:
      "读取用户当前打开的文档与选中的元素（批注/箭头/便签/图卡）。用户说'这个''我选中的'时用它确定指代。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "insert_canvas_image",
    description:
      "把一张图片作为图卡放到画布上（如生成的新版本图）。永不覆盖原图——新产物放旁边。人刷新网页即见，双击图卡可进入批注模式。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "文件名" },
        content_base64: { type: "string", description: "图片内容（base64）" },
        doc: { type: "string", description: "归属文档（相对路径），留空=全局" },
        x: { type: "number", description: "画布 x 坐标" },
        y: { type: "number", description: "画布 y 坐标" },
        width: { type: "number", description: "图卡宽度（120-1200，默认 320）" },
      },
      required: ["name", "content_base64"],
    },
  },
  {
    name: "insert_html_draft",
    description:
      "把单文件 HTML 草稿作为草稿卡放到画布上（iframe 沙箱渲染）。HTML 中的相对图片路径会自动改写为可访问的绝对路径。适合交付可交互预览物（图表/原型/排版稿）。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "文件名（.html）" },
        html: { type: "string", description: "完整 HTML 文档内容" },
        doc: { type: "string", description: "归属文档（相对路径），留空=全局" },
        x: { type: "number" }, y: { type: "number" },
        width: { type: "number", description: "240-1400，默认 560" },
        height: { type: "number", description: "180-1000，默认 360" },
        title: { type: "string", description: "草稿卡标题" },
      },
      required: ["name", "html"],
    },
  },
];

function brief(item) {
  return {
    id: item.id,
    status: item.status,
    weight: item.weight,
    kind: item.kind || "text",
    region: item.region || null,
    image: item.image || null,
    quote: item.quote,
    requirement: item.body,
    conflicts_with: item.conflicts_with || [],
    supersedes: item.supersedes || [],
  };
}

/* MCP 侧 sidecar 读写（与 server 并发窗口极小，tmp+rename 原子写） */
async function loadSidecar() {
  try {
    const data = JSON.parse(await readFile(SIDECAR, "utf8"));
    for (const key of ["arrows", "notes", "images", "drafts"]) {
      if (!Array.isArray(data[key])) data[key] = [];
    }
    return data;
  } catch (err) {
    // ENOENT = 首次使用给空结构；文件存在但读不了 = 拒绝服务（防止空壳覆盖真实数据）
    if (err && err.code === "ENOENT") return { version: 1, docs: {}, arrows: [], notes: [], images: [], drafts: [] };
    throw new Error(`sidecar-unreadable: ${String(err && err.message || err)}`);
  }
}

async function saveSidecar(data) {
  const { writeFile, mkdir, rename, readFile } = await import("node:fs/promises");
  /* 防破坏守卫（与 server 同款）：任何集合数量无故减少即拒绝写盘。
     磁盘存在但读不了时同样拒绝写——宁可失败，绝不拿空/半读数据覆盖事实源 */
  try {
    const current = JSON.parse(await readFile(SIDECAR, "utf8"));
    for (const key of ["arrows", "notes", "images", "drafts"]) {
      const before = Array.isArray(current[key]) ? current[key].length : 0;
      const after = Array.isArray(data[key]) ? data[key].length : 0;
      if (before > after) throw new Error(`blocked-destructive-canvas-loss: ${key} ${before} -> ${after}`);
    }
    const beforeDocs = Object.values(current.docs || {}).reduce((acc, l) => acc + (Array.isArray(l) ? l.length : 0), 0);
    const afterDocs = Object.values(data.docs || {}).reduce((acc, l) => acc + (Array.isArray(l) ? l.length : 0), 0);
    if (beforeDocs > afterDocs) throw new Error(`blocked-destructive-annotation-loss: ${beforeDocs} -> ${afterDocs}`);
  } catch (error) {
    if (String(error).startsWith("Error: blocked-destructive")) throw error;
    if (error && error.code !== "ENOENT") throw new Error(`sidecar-unreadable-refusing-write: ${String(error)}`);
    /* 磁盘无文件：首次写盘，放行 */
  }
  await mkdir(dirname(SIDECAR), { recursive: true });
  // 随机 tmp 后缀：并发请求同进程写盘时避免 rename 竞态
  const tmp = `${SIDECAR}.mcp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, SIDECAR);
}

function nextSeqIn(list, prefix) {
  const max = list.reduce((acc, item) => {
    const n = Number(String(item.id || "").replace(new RegExp(`^${prefix}-`), ""));
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

/* 草稿 HTML 内相对图片路径 → /api/raw 绝对路径（iframe 内相对路径会 404） */
function rewriteDraftAssets(html, draftDir) {
  return html.replace(/(src|href)=(["'])(?!https?:|data:|\/|#)([^"']+)\2/g, (match, attr, quote, value) => {
    const parts = [];
    for (const seg of value.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const abs = [draftDir, ...parts].filter(Boolean).join("/");
    return `${attr}=${quote}/api/raw?p=${encodeURIComponent(abs)}${quote}`;
  });
}

async function callTool(name, args = {}) {
  switch (name) {
    case "list_documents":
      return { documents: await listTree() };
    case "read_document": {
      const target = safeResolve(args.doc);
      if (!target) throw new Error("invalid path");
      return { doc: args.doc, text: await readFile(target, "utf8") };
    }
    case "list_annotations":
      return { doc: args.doc, annotations: (await loadAnnotations(args.doc)).map(brief) };
    case "get_active_constraints": {
      const all = await loadAnnotations(args.doc);
      const list = all
        .filter((item) => item.status === "active")
        .sort((a, b) => b.weight - a.weight);
      // 冲突警告只算对方仍生效的（对方 deprecated = 已裁定/退场）
      for (const item of list) {
        if ((item.conflicts_with || []).length) {
          item.live_conflicts = item.conflicts_with.filter((id) => {
            const other = all.find((entry) => entry.id === id);
            return other && other.status === "active";
          });
        }
      }
      // 手绘箭头标签与便签：人在画布上写的意图，同属约束
      let canvas = { arrows: [], notes: [] };
      try {
        const sidecar = JSON.parse(await readFile(SIDECAR, "utf8"));
        const owns = (item) => !item.doc || item.doc === args.doc;
        canvas.arrows = (sidecar.arrows || []).filter((a) => owns(a) && (a.label || "").trim());
        canvas.notes = (sidecar.notes || []).filter((n) => owns(n) && (n.text || "").trim());
      } catch { /* sidecar 不可读时跳过画布约束 */ }
      return {
        doc: args.doc,
        count: list.length + canvas.arrows.length + canvas.notes.length,
        rule: "以下为人类留下的持久约束，修改文档时必须逐条遵守；过期(stale)批注仅供追溯，不构成约束。手绘箭头与便签同属人类意图。",
        constraints: list.map((item) => {
          const briefItem = brief(item);
          briefItem.conflicts_with = item.live_conflicts || [];
          return briefItem;
        }),
        canvas_arrows: canvas.arrows.map((a) => ({ id: a.id, instruction: a.label.trim() })),
        canvas_notes: canvas.notes.map((n) => ({ id: n.id, instruction: n.text.trim() })),
      };
    }
    case "list_annotation_exports": {
      const dir = join(ROOT, ".marginalia", "exports");
      try {
        const files = (await readdir(dir)).filter((f) => !f.startsWith("."));
        const withTime = [];
        for (const f of files) {
          const info = await stat(join(dir, f));
          withTime.push({ path: join(dir, f), mtime: info.mtimeMs });
        }
        withTime.sort((a, b) => b.mtime - a.mtime);
        return { count: withTime.length, exports: withTime.map((e) => e.path) };
      } catch {
        return { count: 0, exports: [] };
      }
    }
    case "get_annotation_context": {
      const item = (await loadAnnotations(args.doc)).find((entry) => entry.id === args.id);
      if (!item) throw new Error(`annotation ${args.id} not found`);
      return item;
    }
    case "insert_asset": {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const raw = String(args.name || "");
      const clean = raw
        .split(/[\\/]/)
        .filter((seg) => seg && seg !== "." && seg !== "..")
        .map((seg) => seg.replace(/[^\w.\-一-鿿]/g, "_"))
        .join("/");
      if (!clean) throw new Error("invalid name");
      const ext = extname(clean).toLowerCase();
      const ALLOWED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".md", ".markdown", ".txt", ".html", ".htm", ".json", ".csv"]);
      if (!ALLOWED.has(ext)) throw new Error(`extension ${ext} not allowed`);
      const target = safeResolve(clean);
      if (!target) throw new Error("path escapes vault");
      await mkdir(dirname(target), { recursive: true });
      const buffer = args.content_base64 !== undefined
        ? Buffer.from(String(args.content_base64), "base64")
        : Buffer.from(String(args.content_text ?? ""), "utf8");
      await writeFile(target, buffer);
      return {
        ok: true,
        rel: clean,
        abs: target,
        bytes: buffer.length,
        note: "已写入库中。网页刷新文件树即可看到；请勿覆盖原文件——新版本放旁边。",
      };
    }
    case "get_canvas_state": {
      const data = await loadSidecar();
      const pick = (list) => (args.doc ? list.filter((item) => !item.doc || item.doc === args.doc) : list);
      return {
        arrows: pick(data.arrows).map((a) => ({ id: a.id, from: [a.x1, a.y1], to: [a.x2, a.y2], color: a.color, label: a.label, doc: a.doc })),
        notes: pick(data.notes).map((n) => ({ id: n.id, x: n.x, y: n.y, text: n.text, doc: n.doc })),
        images: pick(data.images).map((c) => ({ id: c.id, file: c.file, x: c.x, y: c.y, w: c.w, doc: c.doc })),
        drafts: pick(data.drafts).map((c) => ({ id: c.id, file: c.file, title: c.title, x: c.x, y: c.y, doc: c.doc })),
      };
    }
    case "get_ui_state": {
      try {
        return JSON.parse(await readFile(join(ROOT, ".marginalia", "ui-state.json"), "utf8"));
      } catch {
        return { path: null, selected: null, updated: null, note: "网页尚未上报状态（未打开或版本较旧）" };
      }
    }
    case "insert_canvas_image": {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const clean = String(args.name || "")
        .split(/[\\/]/).filter((s) => s && s !== "." && s !== "..")
        .map((s) => s.replace(/[^\w.\-一-鿿]/g, "_")).join("/");
      if (!clean || !/\.(png|jpg|jpeg|gif|webp|svg|bmp)$/i.test(clean)) throw new Error("invalid image name");
      const rel = join(".marginalia", "assets", clean).split(sep).join("/");
      const target = safeResolve(rel);
      if (!target) throw new Error("path escapes vault");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(String(args.content_base64), "base64"));
      const data = await loadSidecar();
      const card = {
        id: nextSeqIn(data.images, "IMG"),
        file: rel,
        x: Number.isFinite(args.x) ? args.x : 980,
        y: Number.isFinite(args.y) ? args.y : 40,
        w: Math.min(1200, Math.max(120, Number(args.width) || 320)),
        doc: typeof args.doc === "string" && args.doc ? args.doc : null,
        created: new Date().toISOString(),
      };
      data.images.push(card);
      await saveSidecar(data);
      return { ok: true, id: card.id, file: rel, note: "图卡已放入画布，人刷新网页即见（画布元素随归属文档显示）。" };
    }
    case "insert_html_draft": {
      const { writeFile, mkdir } = await import("node:fs/promises");
      const clean = String(args.name || "")
        .split(/[\\/]/).filter((s) => s && s !== "." && s !== "..")
        .map((s) => s.replace(/[^\w.\-一-鿿]/g, "_")).join("/");
      if (!clean || !/\.(html|htm)$/i.test(clean)) throw new Error("invalid html name");
      const draftDir = join(".marginalia", "drafts").split(sep).join("/");
      const rel = `${draftDir}/${clean}`;
      const target = safeResolve(rel);
      if (!target) throw new Error("path escapes vault");
      await mkdir(dirname(target), { recursive: true });
      const html = rewriteDraftAssets(String(args.html || ""), draftDir);
      await writeFile(target, html, "utf8");
      const data = await loadSidecar();
      const card = {
        id: nextSeqIn(data.drafts, "D"),
        file: rel,
        title: typeof args.title === "string" ? args.title.slice(0, 80) : "",
        x: Number.isFinite(args.x) ? args.x : 980,
        y: Number.isFinite(args.y) ? args.y : 40,
        w: Math.min(1400, Math.max(240, Number(args.width) || 560)),
        h: Math.min(1000, Math.max(180, Number(args.height) || 360)),
        doc: typeof args.doc === "string" && args.doc ? args.doc : null,
        created: new Date().toISOString(),
      };
      data.drafts.push(card);
      await saveSidecar(data);
      return { ok: true, id: card.id, file: rel, note: "HTML 草稿卡已放入画布（iframe 沙箱渲染），相对图片路径已改写为绝对路径。" };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

let buffer = "";
let stdinEnded = false;
let pending = 0;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handleMessage(line);
  }
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (pending === 0) process.exit(0);
});

function maybeExit() {
  if (stdinEnded && pending === 0) process.exit(0);
}

function handleMessage(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method?.startsWith("notifications/")) return;
  pending += 1;
  handleRequest(message)
    .then((result) => reply(message.id, result))
    .catch((error) => reply(message.id, { error: { code: -32603, message: String(error) } }))
    .finally(() => {
      pending -= 1;
      maybeExit();
    });
}

async function handleRequest(message) {
  try {
    if (message.method === "initialize") {
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "coeditor", version: "0.8.1" },
      };
    }
    if (message.method === "tools/list") {
      return { tools: TOOLS };
    }
    if (message.method === "tools/call") {
      const result = await callTool(message.params.name, message.params.arguments || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
    if (message.method === "ping") return {};
    return { error: { code: -32601, message: `method not found: ${message.method}` } };
  } catch (error) {
    return { error: { code: -32000, message: String(error && error.message ? error.message : error) } };
  }
}

function reply(id, result) {
  if (id === undefined || id === null) return;
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
