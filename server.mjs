import http from "node:http";
import { readFileSync } from "node:fs";
import { readFile, writeFile, mkdir, stat, readdir, rename } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "public");
let ROOT = resolve(process.argv[2] || process.cwd());
const PORT = Number(process.env.COEDITOR_PORT || 4400);
let SIDECAR = join(ROOT, ".marginalia", "annotations.json");

function setVault(next) {
  ROOT = next;
  SIDECAR = join(ROOT, ".marginalia", "annotations.json");
  UISTATE = join(ROOT, ".marginalia", "ui-state.json");
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".html", ".htm", ".json", ".csv"]);
const BINARY_EXT = new Set([".pdf"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function safeResolve(relPath) {
  const target = resolve(ROOT, relPath || "");
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
  return target;
}

async function readSidecar() {
  try {
    return JSON.parse(await readFile(SIDECAR, "utf8"));
  } catch (err) {
    // 文件不存在 = 首次使用，给空结构；存在但读不了 = 数据危险，拒绝服务（绝不返回空结构，防止空壳覆盖）
    if (err && err.code === "ENOENT") return { version: 1, docs: {}, arrows: [], notes: [], images: [], drafts: [] };
    throw new Error(`sidecar-unreadable: ${String(err && err.message || err)}`);
  }
}

/* 防破坏保存（借鉴 Cowart blocked-destructive-image-loss）：
   批注与画布元素永不无故消失——写盘瞬间任一集合数量减少，直接拒绝保存。
   读不了当前状态时也拒绝写：宁可失败，绝不拿空/半读数据覆盖事实源 */
const CANVAS_KEYS = ["arrows", "notes", "images", "drafts"];
async function writeSidecar(data) {
  let current = null;
  try {
    current = JSON.parse(await readFile(SIDECAR, "utf8"));
  } catch (err) {
    // 文件不存在 = 首次创建，合法跳过守卫；存在但读不了 = 拒绝写（绝不拿空数据覆盖事实源）
    if (!err || err.code !== "ENOENT") throw new Error(`sidecar-unreadable-refusing-write: ${String(err && err.message || err)}`);
  }
  if (current) {
    const countDocs = (d) => Object.values(d.docs || {}).reduce((acc, list) => acc + (Array.isArray(list) ? list.length : 0), 0);
    const beforeDocs = countDocs(current);
    const afterDocs = countDocs(data);
    if (beforeDocs > afterDocs) {
      throw new Error(`blocked-destructive-annotation-loss: ${beforeDocs} -> ${afterDocs}`);
    }
    for (const key of CANVAS_KEYS) {
      const before = Array.isArray(current[key]) ? current[key].length : 0;
      const after = Array.isArray(data[key]) ? data[key].length : 0;
      if (before > after) {
        throw new Error(`blocked-destructive-canvas-loss: ${key} ${before} -> ${after}`);
      }
    }
  }
  for (const key of CANVAS_KEYS) {
    if (!Array.isArray(data[key])) data[key] = [];
  }
  await mkdir(dirname(SIDECAR), { recursive: true });
  // 原子写：先写临时文件再 rename，避免并发/中断导致 sidecar 截断
  const tmp = `${SIDECAR}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  await rename(tmp, SIDECAR);
}

function nextSeq(list, prefix) {
  const max = list.reduce((acc, item) => {
    const n = Number(String(item.id || "").replace(new RegExp(`^${prefix}-`), ""));
    return Number.isFinite(n) ? Math.max(acc, n) : acc;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(4, "0")}`;
}

/* ---------- 锚点偏移与矛盾检测 ---------- */
function offsetsOf(text, quote, prefix) {
  if (!quote) return null;
  let at = text.indexOf(quote);
  if (at < 0 && prefix) {
    const p = text.indexOf(prefix);
    if (p >= 0) at = p + prefix.length;
  }
  if (at < 0 && quote.length > 12) at = text.indexOf(quote.slice(0, 12));
  return at < 0 ? null : { start: at, end: at + quote.length };
}

function overlapRatio(a, b) {
  if (!a || !b) return 0;
  const lo = Math.max(a.start, b.start);
  const hi = Math.min(a.end, b.end);
  if (hi <= lo) return 0;
  return (hi - lo) / Math.min(a.end - a.start, b.end - b.start);
}

async function detectConflicts(docPath, fresh) {
  const target = safeResolve(docPath);
  if (!target) return;
  let text = "";
  try {
    text = await readFile(target, "utf8");
  } catch {
    return;
  }
  fresh.offsets = offsetsOf(text, fresh.quote, fresh.prefix);
  fresh.conflicts_with = fresh.conflicts_with || [];
  const data = await readSidecar();
  const stored = (data.docs[docPath] || []).find((entry) => entry.id === fresh.id);
  for (const other of data.docs[docPath] || []) {
    if (other.id === fresh.id || other.status !== "active") continue;
    if (!other.offsets) other.offsets = offsetsOf(text, other.quote, other.prefix);
    if (overlapRatio(fresh.offsets, other.offsets) >= 0.6) {
      fresh.conflicts_with.push(other.id);
      fresh.history.push({ event: `conflict_with_${other.id}`, at: new Date().toISOString() });
      other.conflicts_with = other.conflicts_with || [];
      other.conflicts_with.push(fresh.id);
      other.history = other.history || [];
      other.history.push({ event: `conflict_with_${fresh.id}`, at: new Date().toISOString() });
    }
  }
  if (stored) {
    stored.offsets = fresh.offsets;
    stored.conflicts_with = fresh.conflicts_with;
    stored.history = fresh.history;
  }
  await writeSidecar(data);
}

async function listTree(dir = ROOT, base = ROOT) {
  const entries = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    const rel = relative(base, full);
    const extension = extname(entry.name).toLowerCase();
    if (entry.isDirectory()) {
      out.push({ name: entry.name, path: rel, type: "dir", children: await listTree(full, base) });
    } else if (TEXT_EXT.has(extension)) {
      out.push({ name: entry.name, path: rel, type: "file", kind: "text" });
    } else if (BINARY_EXT.has(extension)) {
      out.push({ name: entry.name, path: rel, type: "file", kind: "pdf" });
    } else if (IMAGE_EXT.has(extension)) {
      out.push({ name: entry.name, path: rel, type: "file", kind: "image" });
    }
  }
  return out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}

/* UI 状态：前端上报当前文档/选中/视口；落盘 .marginalia/ui-state.json 供 MCP 进程读取
   （Cowart get_selection 对应物） */
let UISTATE = join(ROOT, ".marginalia", "ui-state.json");
let uiState = { path: null, selected: null, updated: null };
try { uiState = JSON.parse(readFileSync(UISTATE, "utf8")); } catch { /* 首次无文件 */ }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = "application/json; charset=utf-8") => {
    res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  };

  try {
    if (url.pathname.startsWith("/api/tree")) {
      return send(200, JSON.stringify({ root: ROOT, tree: await listTree() }));
    }

    if (url.pathname.startsWith("/api/doc")) {
      const target = safeResolve(url.searchParams.get("p"));
      if (!target) return send(400, JSON.stringify({ error: "invalid path" }));
      const info = await stat(target);
      const extension = extname(target).toLowerCase();
      if (BINARY_EXT.has(extension) || IMAGE_EXT.has(extension)) {
        return send(200, JSON.stringify({ path: url.searchParams.get("p"), binary: true, kind: BINARY_EXT.has(extension) ? "pdf" : "image", mtime: info.mtimeMs }));
      }
      const text = await readFile(target, "utf8");
      return send(200, JSON.stringify({ path: url.searchParams.get("p"), text, mtime: info.mtimeMs }));
    }

    /* ---------- 编辑写回：文本文件保存（VSCode 式编辑态） ---------- */
    if (url.pathname.startsWith("/api/write")) {
      const body = await new Promise((ok) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => ok(raw ? JSON.parse(raw) : {}));
      });
      const target = safeResolve(url.searchParams.get("p") || body.p);
      if (!target) return send(400, JSON.stringify({ error: "invalid path" }));
      if (!TEXT_EXT.has(extname(target).toLowerCase())) return send(400, JSON.stringify({ error: "unsupported extension" }));
      if (typeof body.text !== "string") return send(400, JSON.stringify({ error: "text required" }));
      const info = await stat(target).catch(() => null);
      if (info && Number.isFinite(body.baseMtime) && info.mtimeMs !== body.baseMtime) {
        return send(409, JSON.stringify({ error: "file-changed-externally", mtime: info.mtimeMs }));
      }
      await writeFile(target, body.text);
      const after = await stat(target);
      return send(200, JSON.stringify({ ok: true, mtime: after.mtimeMs }));
    }

    /* ---------- 批次：一次「保存本批次」或一次外部修改 = 推进一轮 ---------- */
    if (url.pathname.startsWith("/api/rounds")) {
      const body = await new Promise((ok) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => ok(raw ? JSON.parse(raw) : {}));
      });
      const data = await readSidecar();
      if (body.action === "save") {
        const closed = data.activeRound ?? 0;
        data.activeRound = closed + 1;
        data.roundHistory = data.roundHistory || [];
        data.roundHistory.push({ round: closed, closedAt: new Date().toISOString() });
        await writeSidecar(data);
        return send(200, JSON.stringify({ ok: true, closed, activeRound: data.activeRound }));
      }
      return send(200, JSON.stringify({ activeRound: data.activeRound ?? 0 }));
    }

    /* ---------- 切换 vault（VSCode 式打开本地文件夹） ---------- */
    if (url.pathname.startsWith("/api/vault") && req.method === "POST") {
      const body = await new Promise((ok) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => ok(raw ? JSON.parse(raw) : {}));
      });
      const next = resolve(String(body.path || "").trim());
      const info = await stat(next).catch(() => null);
      if (!info || !info.isDirectory()) return send(400, JSON.stringify({ error: "not a directory" }));
      setVault(next);
      return send(200, JSON.stringify({ ok: true, root: ROOT, tree: await listTree() }));
    }

    if (url.pathname.startsWith("/api/supersede")) {
      const body = await new Promise((ok) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => ok(raw ? JSON.parse(raw) : {}));
      });
      const data = await readSidecar();
      const list = data.docs[url.searchParams.get("p")] || [];
      const winner = list.find((entry) => entry.id === body.winner);
      const loser = list.find((entry) => entry.id === body.loser);
      if (!winner || !loser) return send(404, JSON.stringify({ error: "not found" }));
      loser.status = "deprecated";
      loser.weight = 0;
      loser.history = loser.history || [];
      loser.history.push({ event: `superseded_by_${winner.id}`, at: new Date().toISOString() });
      winner.supersedes = winner.supersedes || [];
      if (!winner.supersedes.includes(loser.id)) winner.supersedes.push(loser.id);
      winner.conflicts_with = (winner.conflicts_with || []).filter((id) => id !== loser.id);
      loser.conflicts_with = (loser.conflicts_with || []).filter((id) => id !== winner.id);
      winner.history = winner.history || [];
      winner.history.push({ event: `supersedes_${loser.id}`, at: new Date().toISOString() });
      await writeSidecar(data);
      return send(200, JSON.stringify({ ok: true, winner, loser }));
    }

    if (url.pathname.startsWith("/api/raw")) {
      const target = safeResolve(url.searchParams.get("p"));
      if (!target) return send(400, JSON.stringify({ error: "invalid path" }));
      const content = await readFile(target);
      const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      return res.end(content);
    }

    if (url.pathname.startsWith("/api/asset")) {
      // 文件名消毒：防路径越界（../../），只允许平铺在 exports / assets 目录
      const raw = url.searchParams.get("name") || `export-${Date.now()}.png`;
      const name = raw.split(/[\\/]/).pop().replace(/[^\w.\-一-鿿]/g, "_") || `export-${Date.now()}.png`;
      const subdir = url.searchParams.get("dir") === "assets" ? "assets" : "exports";
      const dir = join(ROOT, ".marginalia", subdir);
      await mkdir(dir, { recursive: true });
      const target = join(dir, name);
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      await writeFile(target, Buffer.concat(chunks));
      const rel = `.marginalia/${subdir}/${name}`;
      return send(200, JSON.stringify({ ok: true, path: target, rel, url: `/api/raw?p=${encodeURIComponent(rel)}` }));
    }

    /* ---------- 画布元素：手绘标注箭头 + 便签 + 图卡 + HTML 草稿（Cowart 交互层） ---------- */
    if (url.pathname.startsWith("/api/canvas")) {
      const data = await readSidecar();
      for (const key of ["arrows", "notes", "images", "drafts"]) {
        if (!Array.isArray(data[key])) data[key] = [];
      }
      const body = req.method === "GET" ? {} : await new Promise((ok) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => ok(raw ? JSON.parse(raw) : {}));
      });

      if (url.pathname.endsWith("/arrows")) {
        if (req.method === "GET") return send(200, JSON.stringify({ arrows: data.arrows }));
        if (req.method === "POST") {
          // Cowart 美学常量：自动微弯 clamp(len*0.12, 16, 48)；拖太短（<8 world px）丢弃
          const x1 = Number(body.x1); const y1 = Number(body.y1);
          const x2 = Number(body.x2); const y2 = Number(body.y2);
          const len = Math.hypot(x2 - x1, y2 - y1);
          if (![x1, y1, x2, y2].every(Number.isFinite)) return send(400, JSON.stringify({ error: "invalid coords" }));
          if (len < 8) return send(400, JSON.stringify({ error: "too short" }));
          const arrow = {
            id: nextSeq(data.arrows, "AR"),
            x1, y1, x2, y2,
            bend: Math.min(48, Math.max(16, len * 0.12)),
            color: ["red", "yellow", "orange"].includes(body.color) ? body.color : "red",
            label: typeof body.label === "string" ? body.label.slice(0, 120) : "",
            doc: typeof body.doc === "string" && body.doc ? body.doc : null,
            created: new Date().toISOString(),
          };
          data.arrows.push(arrow);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, arrow }));
        }
        if (req.method === "PATCH") {
          const arrow = data.arrows.find((item) => item.id === body.id);
          if (!arrow) return send(404, JSON.stringify({ error: "not found" }));
          for (const field of ["x1", "y1", "x2", "y2"]) {
            if (Number.isFinite(body[field])) arrow[field] = body[field];
          }
          if (typeof body.label === "string") arrow.label = body.label.slice(0, 120);
          if (["red", "yellow", "orange"].includes(body.color)) arrow.color = body.color;
          if (Number.isFinite(body.bend)) arrow.bend = Math.min(120, Math.max(0, body.bend));
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, arrow }));
        }
        if (req.method === "DELETE") {
          const id = url.searchParams.get("id");
          data.arrows = data.arrows.filter((item) => item.id !== id);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true }));
        }
      }

      if (url.pathname.endsWith("/notes")) {
        if (req.method === "GET") return send(200, JSON.stringify({ notes: data.notes }));
        if (req.method === "POST") {
          const note = {
            id: nextSeq(data.notes, "N"),
            x: Number.isFinite(body.x) ? body.x : 200,
            y: Number.isFinite(body.y) ? body.y : 200,
            text: typeof body.text === "string" ? body.text.slice(0, 2000) : "",
            type: body.type === "board" ? "board" : "note",
            doc: typeof body.doc === "string" && body.doc ? body.doc : null,
            created: new Date().toISOString(),
          };
          data.notes.push(note);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, note }));
        }
        if (req.method === "PATCH") {
          const note = data.notes.find((item) => item.id === body.id);
          if (!note) return send(404, JSON.stringify({ error: "not found" }));
          if (Number.isFinite(body.x)) note.x = body.x;
          if (Number.isFinite(body.y)) note.y = body.y;
          if (typeof body.text === "string") note.text = body.text.slice(0, 2000);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, note }));
        }
        if (req.method === "DELETE") {
          const id = url.searchParams.get("id");
          data.notes = data.notes.filter((item) => item.id !== id);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true }));
        }
      }

      /* 画布图卡：人贴图或 Agent insert_canvas_image 落进画布的自由图片元素 */
      if (url.pathname.endsWith("/images")) {
        if (req.method === "GET") return send(200, JSON.stringify({ images: data.images }));
        if (req.method === "POST") {
          const card = {
            id: nextSeq(data.images, "IMG"),
            file: typeof body.file === "string" ? body.file : "",
            x: Number.isFinite(body.x) ? body.x : 200,
            y: Number.isFinite(body.y) ? body.y : 200,
            w: Number.isFinite(body.w) ? Math.min(1200, Math.max(120, body.w)) : 320,
            doc: typeof body.doc === "string" && body.doc ? body.doc : null,
            created: new Date().toISOString(),
          };
          if (!card.file) return send(400, JSON.stringify({ error: "file required" }));
          data.images.push(card);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, image: card }));
        }
        if (req.method === "PATCH") {
          const card = data.images.find((item) => item.id === body.id);
          if (!card) return send(404, JSON.stringify({ error: "not found" }));
          if (Number.isFinite(body.x)) card.x = body.x;
          if (Number.isFinite(body.y)) card.y = body.y;
          if (Number.isFinite(body.w)) card.w = Math.min(1200, Math.max(120, body.w));
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, image: card }));
        }
        if (req.method === "DELETE") {
          const id = url.searchParams.get("id");
          data.images = data.images.filter((item) => item.id !== id);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true }));
        }
      }

      /* HTML 草稿卡：Agent insert_html_draft 生成的单文件 HTML，iframe 沙箱渲染 */
      if (url.pathname.endsWith("/drafts")) {
        if (req.method === "GET") return send(200, JSON.stringify({ drafts: data.drafts }));
        if (req.method === "POST") {
          const card = {
            id: nextSeq(data.drafts, "D"),
            file: typeof body.file === "string" ? body.file : "",
            title: typeof body.title === "string" ? body.title.slice(0, 80) : "",
            x: Number.isFinite(body.x) ? body.x : 200,
            y: Number.isFinite(body.y) ? body.y : 200,
            w: Number.isFinite(body.w) ? Math.min(1400, Math.max(240, body.w)) : 560,
            h: Number.isFinite(body.h) ? Math.min(1000, Math.max(180, body.h)) : 360,
            doc: typeof body.doc === "string" && body.doc ? body.doc : null,
            created: new Date().toISOString(),
          };
          if (!card.file) return send(400, JSON.stringify({ error: "file required" }));
          data.drafts.push(card);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, draft: card }));
        }
        if (req.method === "PATCH") {
          const card = data.drafts.find((item) => item.id === body.id);
          if (!card) return send(404, JSON.stringify({ error: "not found" }));
          if (Number.isFinite(body.x)) card.x = body.x;
          if (Number.isFinite(body.y)) card.y = body.y;
          if (Number.isFinite(body.w)) card.w = Math.min(1400, Math.max(240, body.w));
          if (Number.isFinite(body.h)) card.h = Math.min(1000, Math.max(180, body.h));
          if (typeof body.title === "string") card.title = body.title.slice(0, 80);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true, draft: card }));
        }
        if (req.method === "DELETE") {
          const id = url.searchParams.get("id");
          data.drafts = data.drafts.filter((item) => item.id !== id);
          await writeSidecar(data);
          return send(200, JSON.stringify({ ok: true }));
        }
      }
    }

    /* UI 状态：前端上报当前文档/选中/视口，MCP get_ui_state 读取（Cowart get_selection 对应物） */
    if (url.pathname.startsWith("/api/ui-state")) {
      if (req.method === "POST") {
        const body = await new Promise((ok) => {
          let raw = "";
          req.on("data", (chunk) => (raw += chunk));
          req.on("end", () => ok(raw ? JSON.parse(raw) : {}));
        });
        uiState = {
          path: typeof body.path === "string" ? body.path : null,
          selected: body.selected || null,
          updated: new Date().toISOString(),
        };
        try {
          await mkdir(dirname(UISTATE), { recursive: true });
          await writeFile(UISTATE, JSON.stringify(uiState, null, 2), "utf8");
        } catch { /* 落盘失败不影响前端 */ }
        return send(200, JSON.stringify({ ok: true }));
      }
      return send(200, JSON.stringify(uiState));
    }

    if (url.pathname.startsWith("/api/annotations")) {
      const key = url.searchParams.get("p");
      const data = await readSidecar();
      const list = data.docs[key] || (data.docs[key] = []);

      if (req.method === "GET") {
        return send(200, JSON.stringify({ path: key, annotations: list }));
      }

      const body = await new Promise((ok) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => ok(raw ? JSON.parse(raw) : {}));
      });

      if (req.method === "POST") {
        const KINDS = new Set(["region", "text", "highlight", "strike"]);
        const kind = KINDS.has(body.kind) ? body.kind : "text";
        const isMark = kind === "highlight" || kind === "strike";
        if (!isMark && kind !== "region" && !(body.body || "").trim()) {
          return send(400, JSON.stringify({ error: "annotation body required" }));
        }
        const item = {
          id: nextSeq(list, "A"),
          kind,
          round: Number.isFinite(data.activeRound) ? data.activeRound : 0,
          quote: body.quote || "",
          prefix: body.prefix || "",
          suffix: body.suffix || "",
          body: (body.body || "").trim(),
          x: Number.isFinite(body.x) ? body.x : 850,
          y: Number.isFinite(body.y) ? body.y : 0,
          region: body.region && ["x", "y", "w", "h"].every((k) => Number.isFinite(body.region[k]))
            ? { x: body.region.x, y: body.region.y, w: body.region.w, h: body.region.h }
            : null,
          image: typeof body.image === "string" && body.image ? body.image : null,
          created: new Date().toISOString(),
          status: "active",
          weight: 1,
          history: [{ event: "created", at: new Date().toISOString() }],
          supersedes: [],
          conflicts_with: [],
        };
        list.push(item);
        await writeSidecar(data);
        await detectConflicts(url.searchParams.get("p"), item);
        return send(200, JSON.stringify({ ok: true, annotation: item, conflicts: item.conflicts_with }));
      }

      if (req.method === "PATCH") {
        const item = list.find((entry) => entry.id === body.id);
        if (!item) return send(404, JSON.stringify({ error: "not found" }));
        for (const field of ["body", "status", "weight", "x", "y", "quote", "kind", "region", "image"]) {
          if (body[field] !== undefined) item[field] = body[field];
        }
        item.history = item.history || [];
        item.history.push({ event: body.event || "updated", at: new Date().toISOString() });
        await writeSidecar(data);
        return send(200, JSON.stringify({ ok: true, annotation: item }));
      }
    }

    if (url.pathname.startsWith("/api/constraints")) {
      const data = await readSidecar();
      const list = (data.docs[url.searchParams.get("p")] || []).filter((item) => item.status === "active");
      return send(200, JSON.stringify({
        path: url.searchParams.get("p"),
        count: list.length,
        constraints: list.sort((a, b) => b.weight - a.weight),
      }));
    }

    const rel = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR)) return send(403, "forbidden", "text/plain");
    try {
      const content = await readFile(file);
      return send(200, content, MIME[extname(file)] || "application/octet-stream");
    } catch {
      return send(404, "not found", "text/plain");
    }
  } catch (error) {
    send(500, JSON.stringify({ error: String(error && error.message ? error.message : error) }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`CoEditor ready → http://127.0.0.1:${PORT}`);
  console.log(`vault: ${ROOT}`);
  console.log(`sidecar: ${SIDECAR}`);
});
