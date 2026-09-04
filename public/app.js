const $ = (id) => document.getElementById(id);
const PAGE_W = 760;
const CARD_W = 300;
const CARD_GAP = 18;
const RAIL_X = PAGE_W + 90;

const view = { panX: 60, panY: 40, zoom: 1 };
const state = { path: null, text: "", mtime: 0, annotations: [], selected: null,
  arrows: [], notes: [], images: [], drafts: [], canvasTool: "select", arrowColor: "red", canvasSelected: null,
  vaultRoot: "", workspaceMode: "read" };

function isCanvasMode() { return state.workspaceMode === "canvas"; }
function isEditableDocument() {
  return state.mode === "text" && /\.(md|markdown|txt|html?|json|csv)$/i.test(state.path || "");
}

/* 画布元素按文档归属：无 doc 的旧元素视为全局，始终显示 */
function ownsCanvas(item) {
  return !item.doc || item.doc === state.path;
}

/* ---------------- 坐标 ---------------- */
/* 画布边界：视野 clamp 到「内容 bbox ± slack」，不需要滑到很远的地方 */
function clampView() {
  if (!isCanvasMode()) return;
  const page = $("page");
  const contentW = (page.offsetWidth + CARD_W + 160) || PAGE_W + CARD_W;
  const contentH = (page.offsetHeight + 160) || 900;
  const rect = $("viewport").getBoundingClientRect();
  const slack = 600; // 内容外允许漫游的余量
  view.panX = Math.min(slack, Math.max(rect.width - contentW * view.zoom - slack, view.panX));
  view.panY = Math.min(slack, Math.max(rect.height - contentH * view.zoom - slack, view.panY));
}

function applyTransform() {
  if (!isCanvasMode()) {
    const world = $("world");
    world.style.transform = "none";
    $("page").style.zoom = String(view.zoom);
    $("zoom").textContent = `${Math.round(view.zoom * 100)}%`;
    $("viewport").style.backgroundSize = "auto";
    $("viewport").style.backgroundPosition = "0 0";
    return;
  }
  $("page").style.zoom = "";
  clampView();
  $("world").style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  $("zoom").textContent = `${Math.round(view.zoom * 100)}%`;
  const step = 26 * view.zoom;
  $("viewport").style.backgroundSize = `${step}px ${step}px`;
  $("viewport").style.backgroundPosition = `${view.panX}px ${view.panY}px`;
  drawLines();
}

function toWorld(clientX, clientY) {
  if (!isCanvasMode()) {
    const rect = $("world").getBoundingClientRect();
    return { x: (clientX - rect.left) / view.zoom, y: (clientY - rect.top) / view.zoom };
  }
  const rect = $("viewport").getBoundingClientRect();
  return { x: (clientX - rect.left - view.panX) / view.zoom, y: (clientY - rect.top - view.panY) / view.zoom };
}

function worldRect(element) {
  const rect = element.getBoundingClientRect();
  // iframe 内元素的 rect 是 iframe 视口坐标，先换算回父页面视口坐标（两种模式都需要）
  let left = rect.left;
  let top = rect.top;
  if (element.ownerDocument !== document) {
    const frame = $("html-frame");
    if (frame) {
      const frameRect = frame.getBoundingClientRect();
      left += frameRect.left;
      top += frameRect.top;
    }
  }
  if (!isCanvasMode()) {
    const world = $("world").getBoundingClientRect();
    return { x: (left - world.left) / view.zoom, y: (top - world.top) / view.zoom, w: rect.width / view.zoom, h: rect.height / view.zoom };
  }
  const topLeft = toWorld(left, top);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: rect.width / view.zoom,
    h: rect.height / view.zoom,
  };
}

function zoomAt(factor, clientX, clientY) {
  if (!isCanvasMode()) {
    const viewport = $("viewport");
    const old = view.zoom;
    view.zoom = Math.min(2, Math.max(0.65, view.zoom * factor));
    const ratio = view.zoom / old;
    viewport.scrollLeft = (viewport.scrollLeft + clientX - viewport.getBoundingClientRect().left) * ratio - (clientX - viewport.getBoundingClientRect().left);
    viewport.scrollTop = (viewport.scrollTop + clientY - viewport.getBoundingClientRect().top) * ratio - (clientY - viewport.getBoundingClientRect().top);
    applyTransform();
    return;
  }
  const next = Math.min(2.4, Math.max(0.3, view.zoom * factor));
  const rect = $("viewport").getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;
  view.panX = px - ((px - view.panX) / view.zoom) * next;
  view.panY = py - ((py - view.panY) / view.zoom) * next;
  view.zoom = next;
  applyTransform();
}

function centerOn(worldX, worldY) {
  if (!isCanvasMode()) {
    const viewport = $("viewport");
    viewport.scrollTo({ top: Math.max(0, worldY * view.zoom - viewport.clientHeight * .3), behavior: "smooth" });
    return;
  }
  const rect = $("viewport").getBoundingClientRect();
  view.panX = rect.width / 2 - worldX * view.zoom;
  view.panY = rect.height / 2 - worldY * view.zoom;
  applyTransform();
}

function fit() {
  if (!isCanvasMode()) {
    view.zoom = 1;
    applyTransform();
    $("viewport").scrollTo({ left: 0, top: 0, behavior: "smooth" });
    return;
  }
  const rect = $("viewport").getBoundingClientRect();
  const pageH = $("page").offsetHeight || 800;
  let contentW = PAGE_W;
  let contentH = pageH;
  for (const item of state.annotations) {
    contentW = Math.max(contentW, (item.x || RAIL_X) + CARD_W);
    contentH = Math.max(contentH, (item.y || 0) + 160);
  }
  const zoom = Math.min((rect.width - 120) / contentW, (rect.height - 120) / contentH, 1);
  view.zoom = Math.max(0.3, zoom);
  view.panX = (rect.width - contentW * view.zoom) / 2;
  view.panY = 40;
  applyTransform();
}

/* ---------------- markdown ---------------- */
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text) {
  return escapeHtml(String(text)).replace(/"/g, "&quot;");
}

function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
}

/* 资源路径解析：md 内相对路径 → 相对 vault 根 */
function resolveAssetPath(src) {
  if (/^(https?:|data:|\/)/.test(src)) return src;
  const dir = state.path && state.path.includes("/") ? state.path.slice(0, state.path.lastIndexOf("/")) : "";
  const parts = dir ? dir.split("/") : [];
  for (const seg of src.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

function figureHtml(src, alt) {
  const resolved = resolveAssetPath(src);
  const url = /^https?:|^data:/.test(resolved) ? resolved : `/api/raw?p=${encodeURIComponent(resolved)}`;
  return `<figure class="inline-image" data-image="${escapeHtml(resolved)}">`
    + `<div class="ii-stage"><img src="${url}" alt="${escapeHtml(alt || "")}" draggable="false"><div class="region-layer"></div></div>`
    + (alt ? `<figcaption>${inline(alt)}</figcaption>` : "")
    + `</figure>`;
}

function htmlAssetUrl(value) {
  if (!value || /^(#|https?:|data:|blob:|mailto:|tel:|javascript:)/i.test(value)) return value;
  const resolved = resolveAssetPath(value);
  return `/api/raw?p=${encodeURIComponent(resolved)}`;
}

function rewriteCssAssets(css) {
  return css.replace(/url\((['"]?)([^)'"\s]+)\1\)/gi, (match, quote, value) => {
    const next = htmlAssetUrl(value);
    return next === value ? match : `url("${next}")`;
  });
}

/* HTML 在隔离 iframe 中按原网页渲染。保留 CSS 与布局，不允许脚本触碰 CoEditor。 */
/* HTML 双树：original 保真（脚本与原 URL 不动，负责写回源文件）；
   preview 供 iframe 渲染（脚本中和、资源改写、带 data-coedit 路径标记映射回 original）。 */
let htmlCoedit = null; // { original, map: Map<path, Element> }

function assignCoeditIds(previewEl, originalEl, path, map) {
  map.set(path, originalEl);
  previewEl.setAttribute("data-coedit", path);
  const pv = [...previewEl.children];
  const og = [...originalEl.children];
  pv.forEach((child, i) => { if (og[i]) assignCoeditIds(child, og[i], `${path}.${i}`, map); });
}


function annotationRoot() {
  const frame = $("html-frame");
  return frame && frame.contentDocument && frame.contentDocument.body ? frame.contentDocument.body : $("doc");
}

function findAnchor(id) {
  return annotationRoot().querySelector(`.anchor[data-ann="${id}"]`);
}

function renderMarkdown(source) {
  const out = [];
  let list = null;
  let code = false;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) { closeList(); out.push(code ? "</code></pre>" : "<pre><code>"); code = !code; continue; }
    if (code) { out.push(escapeHtml(line) + "\n"); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) { closeList(); out.push("<hr>"); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { closeList(); const l = heading[1].length; out.push(`<h${l}>${inline(heading[2])}</h${l}>`); continue; }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { closeList(); out.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }
    const image = /^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)\s*$/.exec(line);
    if (image) { closeList(); out.push(figureHtml(image[2], image[1])); continue; }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) { if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push(`<li>${inline(bullet[1])}</li>`); continue; }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) { if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push(`<li>${inline(ordered[1])}</li>`); continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  if (code) out.push("</code></pre>");
  return out.join("\n");
}

/* ---------------- 锚点 ---------------- */
function buildIndex(root) {
  const owner = root.ownerDocument || document;
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const map = [];
  let text = "";
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue;
    for (let i = 0; i < value.length; i += 1) {
      text += value[i];
      map.push({ node, offset: i });
    }
  }
  return { text, map };
}

function locate(index, annotation) {
  const candidates = [annotation.quote];
  if (annotation.quote && annotation.quote.length > 24) candidates.push(annotation.quote.slice(0, 24));
  if (annotation.prefix) candidates.push((annotation.prefix + annotation.quote).slice(-annotation.quote.length));
  for (const candidate of candidates) {
    if (!candidate) continue;
    const hits = [];
    let at = index.text.indexOf(candidate);
    while (at >= 0) { hits.push(at); at = index.text.indexOf(candidate, at + 1); }
    if (!hits.length) continue;
    // 多处命中时用 prefix/suffix 上下文消歧，避免重复句钉到第一处
    let best = hits[0];
    let bestScore = -1;
    for (const start of hits) {
      let score = 0;
      if (annotation.prefix && index.text.slice(Math.max(0, start - annotation.prefix.length), start) === annotation.prefix) score += 2;
      if (annotation.suffix && index.text.slice(start + candidate.length, start + candidate.length + annotation.suffix.length) === annotation.suffix) score += 2;
      if (score > bestScore) { bestScore = score; best = start; }
      if (score === 4) break;
    }
    return { start: best, end: best + candidate.length, drifted: candidate !== annotation.quote };
  }
  return null;
}

function wrapRange(map, start, end, id) {
  let i = start;
  while (i < end) {
    const { node, offset } = map[i];
    let length = 1;
    while (i + length < end && map[i + length] && map[i + length].node === node && map[i + length].offset === offset + length) length += 1;
    const owner = node.ownerDocument || document;
    const range = owner.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + length);
    const mark = owner.createElement("mark");
    mark.dataset.ann = id;
    mark.className = "anchor";
    try {
      range.surroundContents(mark);
    } catch {
      const span = owner.createElement("span");
      span.dataset.ann = id;
      span.className = "anchor";
      span.appendChild(range.extractContents());
      range.insertNode(span);
    }
    i += length;
  }
}

async function anchorAll() {
  let decayed = 0;
  const root = annotationRoot();
  for (const annotation of state.annotations) {
    if (annotation.region) continue; // 区域批注不参与文本锚定
    const index = buildIndex(root); // 每条重建：wrapRange 会改变 DOM 文本节点
    const hit = locate(index, annotation);
    annotation.__lost = !hit;
    annotation.__drifted = Boolean(hit && hit.drifted);
    if (!hit) {
      if (annotation.status === "active") {
        annotation.status = "stale";
        annotation.weight = Math.max(0.2, Number(annotation.weight ?? 1) * 0.5);
        await patch(annotation.id, { status: annotation.status, weight: annotation.weight, event: "anchor_lost" });
        decayed += 1;
      }
      continue;
    }
    wrapRange(index.map, hit.start, hit.end, annotation.id);
  }
  root.querySelectorAll(".anchor").forEach((node) => {
    const item = state.annotations.find((entry) => entry.id === node.dataset.ann);
    node.dataset.status = item ? item.status : "active";
    node.dataset.kind = item && (item.kind === "highlight" || item.kind === "strike") ? item.kind : "comment";
  });
  return decayed;
}

/* ---------------- 卡片 ---------------- */
const LABELS = { active: "本轮", addressed: "已处理", stale: "已过期", deprecated: "已移除" };

function displayNo(itemOrId) {
  const item = typeof itemOrId === "string"
    ? state.annotations.find((entry) => entry.id === itemOrId)
    : itemOrId;
  return item ? (item.no || item.id) : String(itemOrId || "");
}

function weightDots(weight) {
  const filled = Math.round(Number(weight ?? 1) * 5);
  return Array.from({ length: 5 }, (_, i) => `<i class="${i < filled ? "on" : ""}"></i>`).join("");
}

function cardElement(annotation) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = annotation.id;
  card.dataset.status = annotation.status;
  card.style.left = `${annotation.x ?? RAIL_X}px`;
  card.style.top = `${annotation.y ?? 0}px`;
  const conflicting = (annotation.conflicts_with || []).filter((otherId) => {
    const other = state.annotations.find((entry) => entry.id === otherId);
    return other && other.status === "active";
  });
  const KIND_BADGE = { highlight: '<span class="c-kind hl">保留</span>', strike: '<span class="c-kind st">删除线</span>', region: '<span class="c-kind rg">区域</span>' };
  const roundNo = Number.isFinite(annotation.round) ? annotation.round : 0;
  const isCurrentRound = roundNo === (state.round ?? 0);
  card.dataset.roundCur = isCurrentRound ? "1" : "0";
  const visibleNo = displayNo(annotation);
  const actions = annotation.kind === "highlight"
    ? '<button data-act="delete" class="danger">取消保留</button>'
    : `${annotation.status === "active" ? '<button data-act="edit">编辑</button><button data-act="addressed">已处理</button><button data-act="deprecated">移到历史</button>' : '<button data-act="revive">恢复</button>'}<button data-act="delete" class="danger">删除</button>${conflicting.length ? '<button data-act="supersede">以此为准</button>' : ""}`;
  card.innerHTML = `
    <div class="c-head">
      <span class="c-id">${visibleNo}</span>
      ${KIND_BADGE[annotation.kind] || ""}
      ${annotation.status !== "active" ? `<span class="c-badge">${LABELS[annotation.status] || annotation.status}</span>` : ""}
      ${annotation.__drifted ? '<span class="c-flag">漂移</span>' : ""}
      ${annotation.__lost ? '<span class="c-flag">锚点失效</span>' : ""}
      ${conflicting.length ? `<span class="c-conflict" title="与 ${conflicting.map(displayNo).join("、")} 针对同一处原文，需裁定">冲突 ${conflicting.map(displayNo).join("/")}</span>` : ""}
      ${Number(annotation.weight ?? 1) < 1 ? `<span class="c-weight" title="权重 ${Number(annotation.weight ?? 1).toFixed(2)}">${weightDots(annotation.weight)}</span>` : ""}
    </div>
    <div class="c-body">${escapeHtml(annotation.body || (annotation.kind === "highlight" ? "（标记保留 · 这段内容要保留）" : annotation.kind === "strike" ? "（删除线标记 · 建议删除此段）" : ""))}</div>
    <div class="c-quote">${escapeHtml(annotation.quote || "（原文已变更，锚点失效）")}</div>
    <div class="c-actions">${actions}</div>`;

  card.addEventListener("mouseenter", () => { state.hovered = annotation.id; drawLines(); });
  card.addEventListener("mouseleave", () => { state.hovered = null; drawLines(); });

  card.addEventListener("mousedown", (event) => {
    if (event.target.tagName === "BUTTON") return;
    event.stopPropagation();
    selectCard(annotation.id);
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = parseFloat(card.style.left);
    const originY = parseFloat(card.style.top);
    card.classList.add("dragging");
    const move = (moveEvent) => {
      card.style.left = `${originX + (moveEvent.clientX - startX) / view.zoom}px`;
      card.style.top = `${originY + (moveEvent.clientY - startY) / view.zoom}px`;
      drawLines();
    };
    const up = async () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      card.classList.remove("dragging");
      annotation.x = parseFloat(card.style.left);
      annotation.y = parseFloat(card.style.top);
      await patch(annotation.id, { x: annotation.x, y: annotation.y, event: "moved" });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  card.addEventListener("click", (event) => {
    if (event.target.tagName === "BUTTON") return;
    const mark = findAnchor(annotation.id);
    if (!mark) return toast("这条批注的原文已找不到，已自动标记过期");
    mark.classList.remove("flash");
    void mark.offsetWidth;
    mark.classList.add("flash");
    const rect = worldRect(mark);
    centerOn(rect.x + rect.w / 2, rect.y + rect.h / 2);
  });

  card.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", async (event) => {
      event.stopPropagation();
      const act = button.dataset.act;
      if (act === "supersede") {
        const losers = (annotation.conflicts_with || []).filter((otherId) => {
          const other = state.annotations.find((entry) => entry.id === otherId);
          return other && other.status === "active";
        });
        for (const loser of losers) {
          await fetch(`/api/supersede?p=${encodeURIComponent(state.path)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ winner: annotation.id, loser }),
          });
        }
        await loadAnnotations();
        toast(`${displayNo(annotation)} 已替代 ${losers.map(displayNo).join("、")}（旧批注保留在历史中）`);
        return;
      }
      if (act === "edit") { startCardEdit(card, annotation); return; }
      if (act === "save-edit") {
        const ta = card.querySelector(".card-edit");
        await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: annotation.id, body: ta.value, event: "edited" }),
        });
        await loadAnnotations();
        toast("批注已更新");
        return;
      }
      if (act === "cancel-edit") { await loadAnnotations(); return; }
      if (act === "delete") {
        await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: annotation.id }),
        });
        await loadAnnotations();
        toast(annotation.kind === "highlight" ? "已取消保留" : "批注已删除");
        return;
      }
      const next = act === "addressed" ? { status: "addressed", weight: 0.5 }
        : act === "deprecated" ? { status: "deprecated", weight: 0 }
        : { status: "active", weight: 1 };
      await patch(annotation.id, { ...next, event: act });
      await loadAnnotations();
    });
  });
  return card;
}

function selectCard(id) {
  state.selected = id;
  document.querySelectorAll(".card").forEach((node) => node.classList.toggle("selected", node.dataset.id === id));
  drawLines();
  reportUiState();
}

function renderCards() {
  const host = $("cards");
  host.innerHTML = "";
  for (const annotation of state.annotations) host.appendChild(cardElement(annotation));
  const active = state.annotations.filter((item) => item.status === "active").length;
  $("stat-count").textContent = state.annotations.length;
  $("stat-active").textContent = active;
}

/* 卡片内联编辑批注文字 */
function startCardEdit(card, annotation) {
  if (card.querySelector(".card-edit")) return;
  const body = card.querySelector(".c-body");
  if (!body) return;
  const ta = document.createElement("textarea");
  ta.className = "card-edit";
  ta.value = annotation.body || "";
  ta.rows = Math.min(6, Math.max(2, ta.value.split("\n").length + 1));
  body.replaceWith(ta);
  ta.focus();
  const actions = card.querySelector(".c-actions");
  if (actions) {
    actions.innerHTML = '<button class="primary">保存 ⌘S</button><button class="ghost">取消</button>';
    const [save, cancel] = actions.querySelectorAll("button");
    save.addEventListener("click", async (event) => {
      event.stopPropagation();
      await patch(annotation.id, { body: ta.value.trim(), event: "edited" });
      await loadAnnotations();
      toast("批注已更新");
    });
    cancel.addEventListener("click", async (event) => { event.stopPropagation(); await loadAnnotations(); });
    ta.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); save.click(); }
      if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
    });
  }
}

/* ---------------- 牵引线 ---------------- */
function drawLines() {
  const svg = $("lines");
  svg.setAttribute("width", "12000");
  svg.setAttribute("height", "12000");
  svg.innerHTML = "";
  const pageRect = worldRect($("page"));
  for (const annotation of state.annotations) {
    if (annotation.kind === "highlight") continue; // 保留标记：不牵引线（正文黄底即表达）
    const mark = findAnchor(annotation.id)
      || $("doc").querySelector(`.region[data-ann="${annotation.id}"]`);
    const card = $("cards").querySelector(`.card[data-id="${annotation.id}"]`);
    const cardX = annotation.x ?? RAIL_X;
    const cardY = (annotation.y ?? 0) + 26;
    const color = { active: "#e0604f", addressed: "#6fa055", stale: "#c99537", deprecated: "#7d7a75" }[annotation.status] || "#7d7a75";
    if (!mark) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${pageRect.x + pageRect.w} ${cardY} L ${cardX} ${cardY}`);
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", color);
      path.setAttribute("stroke-width", "1");
      path.setAttribute("stroke-dasharray", "3 5");
      path.setAttribute("opacity", "0.4");
      svg.appendChild(path);
      continue;
    }
    const rect = worldRect(mark);
    const x1 = rect.x + rect.w;
    const y1 = rect.y + rect.h / 2;
    const x2 = cardX;
    const y2 = cardY;
    const mid = (x1 + x2) / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", annotation.id === state.selected ? "1.8" : "1.1");
    path.setAttribute("stroke-dasharray", annotation.status === "deprecated" ? "4 4" : "0");
    path.setAttribute("opacity", annotation.status === "deprecated" ? "0.5" : "0.85");
    path.dataset.status = annotation.status;
    path.dataset.ann = annotation.id;
    if (annotation.id === state.selected || annotation.id === state.hovered) path.classList.add("lit");
    svg.appendChild(path);
  }
}

/* ---------------- 图片节点：区域批注与标注导出 ---------------- */
function findRegionLayer(annotation) {
  if (state.mode === "image") return $("region-layer");
  if (state.mode === "pdf" && annotation.region && Number.isFinite(annotation.region.page)) {
    const pageEl = $("doc").querySelector(`.pdf-page[data-page="${annotation.region.page}"]`);
    return pageEl ? pageEl.querySelector(".region-layer") : null;
  }
  const target = annotation.image || "";
  for (const fig of $("doc").querySelectorAll("figure.inline-image")) {
    if (fig.dataset.image === target) return fig.querySelector(".region-layer");
  }
  return null;
}

function renderRegions() {
  document.querySelectorAll(".region-layer").forEach((node) => { node.innerHTML = ""; });
  for (const annotation of state.annotations) {
    if (!annotation.region) continue;
    const layer = findRegionLayer(annotation);
    if (!layer) continue;
    const box = document.createElement("div");
    box.className = "region";
    box.dataset.ann = annotation.id;
    box.dataset.status = annotation.status;
    box.style.left = `${annotation.region.x * 100}%`;
    box.style.top = `${annotation.region.y * 100}%`;
    box.style.width = `${annotation.region.w * 100}%`;
    box.style.height = `${annotation.region.h * 100}%`;
    box.innerHTML = `<span>${displayNo(annotation)}</span>`;
    layer.appendChild(box);
  }
}

let activeImageRegionPointer = null;
function bindRegionStage(stage, imagePath) {
  if (stage.dataset.regionBound === "1") return;
  stage.dataset.regionBound = "1";
  stage.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (activeImageRegionPointer !== null || !$("composer").hidden) return;
    event.preventDefault();
    event.stopPropagation();
    activeImageRegionPointer = event.pointerId;
    stage.setPointerCapture(event.pointerId);
    const bounds = stage.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const draft = document.createElement("div");
    draft.className = "region-draft";
    stage.appendChild(draft);
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      const cx = Math.max(bounds.left, Math.min(bounds.right, moveEvent.clientX));
      const cy = Math.max(bounds.top, Math.min(bounds.bottom, moveEvent.clientY));
      const x1 = Math.min(startX, cx) - bounds.left;
      const y1 = Math.min(startY, cy) - bounds.top;
      const x2 = Math.max(startX, cx) - bounds.left;
      const y2 = Math.max(startY, cy) - bounds.top;
      draft.style.left = `${x1}px`;
      draft.style.top = `${y1}px`;
      draft.style.width = `${x2 - x1}px`;
      draft.style.height = `${y2 - y1}px`;
    };
    const up = (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", cancel);
      if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
      activeImageRegionPointer = null;
      draft.remove();
      const endX = Math.max(bounds.left, Math.min(bounds.right, upEvent.clientX));
      const endY = Math.max(bounds.top, Math.min(bounds.bottom, upEvent.clientY));
      const x = Math.min(startX, endX) - bounds.left;
      const y = Math.min(startY, endY) - bounds.top;
      const w = Math.abs(endX - startX);
      const h = Math.abs(endY - startY);
      if (w < 12 || h < 12) return;
      const label = imagePath ? `图片 ${imagePath.split("/").pop()} 区域` : "区域";
      pending = {
        kind: "region",
        quote: `${label} (${(x / bounds.width).toFixed(2)}, ${(y / bounds.height).toFixed(2)})`,
        prefix: "",
        suffix: "",
        image: imagePath || null,
        region: {
          x: x / bounds.width,
          y: y / bounds.height,
          w: w / bounds.width,
          h: h / bounds.height,
        },
        worldY: toWorld(bounds.left + x, bounds.top + y).y,
      };
      const composer = $("composer");
      composer.hidden = false;
      composer.style.top = `${Math.min(upEvent.clientY + 12, window.innerHeight - 220)}px`;
      composer.style.left = `${Math.min(upEvent.clientX, window.innerWidth - 360)}px`;
      $("composer-quote").textContent = `框选区域 ${Math.round(w)}×${Math.round(h)} px`;
      $("composer-input").focus();
    };
    const cancel = (cancelEvent) => {
      if (cancelEvent.pointerId !== event.pointerId) return;
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
      stage.removeEventListener("pointercancel", cancel);
      activeImageRegionPointer = null;
      draft.remove();
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", cancel);
  });
}

function bindImageSelection() {
  const stage = $("image-stage");
  const bindLoadedGeometry = (target) => {
    const image = target.querySelector("img");
    if (!image || image.dataset.geometryBound === "1") return;
    image.dataset.geometryBound = "1";
    const redraw = () => { renderRegions(); drawLines(); };
    image.addEventListener("load", redraw);
    if (image.complete) requestAnimationFrame(redraw);
  };
  if (stage) { bindRegionStage(stage, null); bindLoadedGeometry(stage); }
  for (const inline of $("doc").querySelectorAll(".ii-stage")) {
    bindRegionStage(inline, inline.closest("figure.inline-image").dataset.image);
    bindLoadedGeometry(inline);
  }
}

async function exportAnnotatedImage({ openDrawer = true } = {}) {
  const image = $("image-node");
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);

  const listed = state.annotations.filter((item) => item.region && item.status !== "deprecated" && (!item.image || item.image === state.path));
  const scaleUnit = Math.max(canvas.width, canvas.height);
  for (const annotation of listed) {
    const x = annotation.region.x * canvas.width;
    const y = annotation.region.y * canvas.height;
    const w = annotation.region.w * canvas.width;
    const h = annotation.region.h * canvas.height;
    const color = annotation.status === "active" ? "#e0604f" : "#c99537";
    context.strokeStyle = color;
    context.lineWidth = Math.max(2, scaleUnit * 0.003);
    context.strokeRect(x, y, w, h);
    const font = Math.round(scaleUnit * 0.024);
    context.font = `600 ${font}px -apple-system, Helvetica, sans-serif`;
    const visibleNo = displayNo(annotation);
    const textWidth = context.measureText(visibleNo).width;
    const pad = font * 0.4;
    context.fillStyle = color;
    context.fillRect(x, y - font - pad * 2, textWidth + pad * 2, font + pad * 2);
    context.fillStyle = "#fff";
    context.fillText(visibleNo, x + pad, y - pad * 1.4);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const base = (state.path.split("/").pop() || "image").replace(/\.[^.]+$/, "");
  const name = `${base}-annotated-${Date.now()}.png`;
  const response = await fetch(`/api/asset?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
  const saved = await response.json();

  if (!openDrawer) return { saved, listed };

  const lines = [
    "[@CoEditor] 按标注修改图片",
    "",
    `源图：${state.path}`,
    `标注截图：${saved.rel}`,
    "",
    "当前标注：",
    ...listed.map((item) => `- [${displayNo(item)}] ${item.body}（区域 x=${item.region.x.toFixed(2)} y=${item.region.y.toFixed(2)} w=${item.region.w.toFixed(2)} h=${item.region.h.toFixed(2)}）`),
    "",
    "要求：以原图为基础，按上述标注生成一张去掉标注痕迹的新图，放在原图旁边；不要覆盖原图，也不要修改或删除任何已有标注。",
  ];
  $("drawer-body").innerHTML = `
    <div class="d-item">
      <div class="d-item-head"><span class="c-id">标注图已导出</span></div>
      <div class="d-item-body"><a href="${saved.url}" target="_blank">${escapeHtml(saved.rel)}</a></div>
    </div>
    <textarea id="export-prompt" class="d-export">${escapeHtml(lines.join("\n"))}</textarea>
    <button id="export-copy" class="chip">复制指令给 Agent</button>`;
  $("drawer").hidden = false;
  $("export-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(lines.join("\n"));
    toast("指令已复制，粘贴给 Agent 即可改图");
  });
  return { saved, listed };
}

/* ---------------- 按标注修改（Cowart 式一键委托，泛化到所有文档类型） ---------------- */
async function askEditWithAnnotations() {
  if (!state.path) return toast("先打开一个文档");
  $("view-menu").open = false;
  let screenshotRel = null;
  if (state.mode === "image" && $("image-node")) {
    const listed = state.annotations.filter((item) => item.region && item.status !== "deprecated" && (!item.image || item.image === state.path));
    if (listed.length) {
      const result = await exportAnnotatedImage({ openDrawer: false });
      screenshotRel = result.saved.rel;
    }
  }
  const active = state.annotations
    .filter((item) => item.status === "active")
    .sort((a, b) => b.weight - a.weight);
  // 画布只保留箭头与图片；便签/白板已从产品交互中移除。
  const canvasArrows = state.arrows.filter((item) => ownsCanvas(item) && (item.label || "").trim());
  const lines = [
    `[@CoEditor] 按标注修改 ${state.path}`,
    "",
    "请根据这份文档的人类批注修改它：",
    `- 目标文件：${state.path}`,
    `- 当前批注 ${active.length} 条，每条都是必须尊重的约束；标记冲突的条目未经裁定前先询问用户`,
    ...(screenshotRel ? [`- 图片标注截图：${screenshotRel}（区域框与编号已烧录进图，作为权威视觉参考）`] : []),
    state.mode === "image"
      ? "- 产出新版本图片放在原图旁边，不要覆盖原图"
      : "- 直接在文件上修改；文本批注对应的原文位置可用 quote 上下文定位",
    "- 完成后逐条核对：在回复里按 轮次-序号（如 0-1）列出处理结果",
    "- 不要修改或删除 .marginalia/ 下的任何批注记录",
    "",
    "当前批注：",
    ...active.map((item) => {
      const where = item.region
        ? `${item.region.page ? `第 ${item.region.page} 页 ` : ""}区域 x=${item.region.x.toFixed(2)} y=${item.region.y.toFixed(2)} w=${item.region.w.toFixed(2)} h=${item.region.h.toFixed(2)}${item.image ? ` · 图 ${item.image}` : ""}`
        : `「${(item.quote || "").slice(0, 60)}」`;
      const conflict = (item.conflicts_with || []).length ? ` ⚠与${item.conflicts_with.map(displayNo).join("/")}冲突` : "";
      return `- [${displayNo(item)}] w=${Number(item.weight ?? 1).toFixed(2)} ${where} → ${item.body}${conflict}`;
    }),
    ...(canvasArrows.length ? [
      "",
      "画布手绘箭头（人的视觉指令）：",
      ...canvasArrows.map((item) => `- [${item.id}]「${item.label.trim()}」`),
    ] : []),
  ];
  const total = active.length + canvasArrows.length;
  // 先补时间戳再 join：prompt 是一次性字符串，事后改 lines[0] 不会反映进去
  const stamp = new Date().toLocaleString("zh-CN", { hour12: false });
  lines[0] = `[@CoEditor] 按标注修改 ${state.path} · 生成于 ${stamp}`;
  const prompt = lines.join("\n");
  // 落盘名沿用 vault 既有命名习惯（研究设计笔记-改写提案.md）：<文档名>-修改指令.md
  const briefName = `${(state.path || "未命名").replace(/\.[^./]+$/, "")}-修改指令.md`;
  $("drawer-body").innerHTML = `
    <div class="d-item">
      <div class="d-item-head"><span class="c-id">修改指令已组装</span></div>
      <div class="d-item-body">${total} 条约束（批注 ${active.length} · 箭头 ${canvasArrows.length}）${screenshotRel ? " · 标注图已导出" : ""}。复制给 Agent，或存成 .md 放进目录——Agent 有目录读权限时自己读文件更省事。</div>
    </div>
    <textarea id="export-prompt" class="d-export">${escapeHtml(prompt)}</textarea>
    <div class="d-export-actions">
      <button id="export-copy" class="chip">复制修改指令</button>
      <button id="export-save-md" class="chip">存为 .md 放进目录</button>
    </div>`;
  $("drawer").hidden = false;
  $("export-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(prompt);
    toast("修改指令已复制，粘贴给 Agent 即可");
  });
  $("export-save-md").addEventListener("click", async () => {
    const res = await fetch("/api/save-brief", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: briefName, text: prompt }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return toast(data.error === "empty" ? "没有可保存的指令" : "保存失败，请重试");
    toast(`已存为 ${data.rel}`);
    await loadTree();
  });
}

/* ---------------- 手绘标注箭头（Cowart 交互层） ---------------- */
const ARROW_COLORS = { red: "#e0604f", orange: "#e8842c", yellow: "#d9a514" };

function arrowSeed(id) {
  let seed = 0;
  for (const ch of String(id)) seed = (seed * 31 + ch.charCodeAt(0)) % 9973;
  return seed;
}

/* 主曲线采样 + 法向微颤 = 手绘感；tldraw 弯箭头：控制点在中点沿法线偏移 bend */
function arrowSamplePoints(arrow) {
  const { x1, y1, x2, y2, bend } = arrow;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const cx = (x1 + x2) / 2 + nx * bend;
  const cy = (y1 + y2) / 2 + ny * bend;
  const seed = arrowSeed(arrow.id);
  const pts = [];
  const N = 14;
  for (let i = 0; i <= N; i += 1) {
    const t = i / N;
    const it = 1 - t;
    let px = it * it * x1 + 2 * it * t * cx + t * t * x2;
    let py = it * it * y1 + 2 * it * t * cy + t * t * y2;
    const tx = 2 * it * (cx - x1) + 2 * t * (x2 - cx);
    const ty = 2 * it * (cy - y1) + 2 * t * (y2 - cy);
    const tl = Math.hypot(tx, ty) || 1;
    const jitter = Math.sin(seed + i * 2.7) * 1.15;
    px += (-ty / tl) * jitter;
    py += (tx / tl) * jitter;
    pts.push([px, py]);
  }
  return pts;
}

function arrowHead(pts) {
  const n = pts.length;
  const [ex, ey] = pts[n - 1];
  const [px, py] = pts[n - 2];
  const dx = ex - px;
  const dy = ey - py;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const size = 11;
  const wing = (sign) => [ex - ux * size + -uy * sign * size * 0.62, ey - uy * size + ux * sign * size * 0.62];
  const [wx1, wy1] = wing(1);
  const [wx2, wy2] = wing(-1);
  return `${ex},${ey} ${wx1},${wy1} ${wx2},${wy2}`;
}

function drawArrows() {
  const svg = $("arrows");
  svg.innerHTML = "";
  svg.setAttribute("width", "12000");
  svg.setAttribute("height", "12000");
  const NS = "http://www.w3.org/2000/svg";
  for (const arrow of state.arrows) {
    if (!ownsCanvas(arrow)) continue;
    const group = document.createElementNS(NS, "g");
    group.setAttribute("class", `arrow-g${state.canvasSelected && state.canvasSelected.type === "arrow" && state.canvasSelected.id === arrow.id ? " selected" : ""}`);
    group.dataset.id = arrow.id;
    const color = ARROW_COLORS[arrow.color] || ARROW_COLORS.red;

    const pts = arrowSamplePoints(arrow);
    const stroke = document.createElementNS(NS, "path");
    stroke.setAttribute("class", "arrow-stroke");
    stroke.setAttribute("d", `M ${pts.map((p) => `${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" L ")}`);
    stroke.setAttribute("stroke", color);
    group.appendChild(stroke);

    const head = document.createElementNS(NS, "polygon");
    head.setAttribute("points", arrowHead(pts));
    head.setAttribute("fill", color);
    group.appendChild(head);

    if (arrow.label) {
      const label = document.createElementNS(NS, "text");
      label.setAttribute("class", "arrow-label");
      label.setAttribute("x", arrow.x1 + 14);
      label.setAttribute("y", arrow.y1 - 14);
      label.textContent = arrow.label;
      group.appendChild(label);
      const size = label.getBBox();
      const bg = document.createElementNS(NS, "rect");
      bg.setAttribute("class", "arrow-label-bg");
      bg.setAttribute("x", size.x - 6);
      bg.setAttribute("y", size.y - 4);
      bg.setAttribute("width", size.width + 12);
      bg.setAttribute("height", size.height + 8);
      bg.setAttribute("rx", 5);
      group.insertBefore(bg, label);
    }

    for (const [hx, hy] of [[arrow.x1, arrow.y1], [arrow.x2, arrow.y2]]) {
      const handle = document.createElementNS(NS, "circle");
      handle.setAttribute("class", "arrow-handle");
      handle.setAttribute("cx", hx);
      handle.setAttribute("cy", hy);
      handle.setAttribute("r", 4.5);
      handle.dataset.end = hx === arrow.x1 && hy === arrow.y1 ? "start" : "end";
      group.appendChild(handle);
    }

    group.addEventListener("pointerdown", (event) => {
      if (state.canvasTool !== "select") return;
      event.stopPropagation();
      selectCanvas({ type: "arrow", id: arrow.id });
      const start = toWorld(event.clientX, event.clientY);
      const target = event.target;
      const endpoint = target.classList.contains("arrow-handle") ? target.dataset.end : null;
      const origin = { x1: arrow.x1, y1: arrow.y1, x2: arrow.x2, y2: arrow.y2 };
      const move = (moveEvent) => {
        const p = toWorld(moveEvent.clientX, moveEvent.clientY);
        if (endpoint === "start") { arrow.x1 = p.x; arrow.y1 = p.y; }
        else if (endpoint === "end") { arrow.x2 = p.x; arrow.y2 = p.y; }
        else {
          arrow.x1 = origin.x1 + (p.x - start.x);
          arrow.y1 = origin.y1 + (p.y - start.y);
          arrow.x2 = origin.x2 + (p.x - start.x);
          arrow.y2 = origin.y2 + (p.y - start.y);
        }
        drawArrows();
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        canvasPatch("/api/canvas/arrows", { id: arrow.id, x1: arrow.x1, y1: arrow.y1, x2: arrow.x2, y2: arrow.y2 });
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    group.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      openArrowLabelEditor(arrow);
    });
    svg.appendChild(group);
  }
}

function selectCanvas(selection) {
  state.canvasSelected = selection;
  document.querySelectorAll(".arrow-g").forEach((node) => node.classList.remove("selected"));
  document.querySelectorAll(".note").forEach((node) => node.classList.remove("selected"));
  document.querySelectorAll(".image-card, .draft-card").forEach((node) => node.classList.remove("selected"));
  if (!selection) { reportUiState(); return; }
  if (selection.type === "arrow") {
    const node = $("arrows").querySelector(`.arrow-g[data-id="${selection.id}"]`);
    if (node) node.classList.add("selected");
  } else if (selection.type === "note") {
    const node = $("notes-layer").querySelector(`.note[data-id="${selection.id}"]`);
    if (node) node.classList.add("selected");
  } else if (selection.type === "image") {
    const node = $("images-layer").querySelector(`.image-card[data-id="${selection.id}"]`);
    if (node) node.classList.add("selected");
  } else if (selection.type === "draft") {
    const node = $("drafts-layer").querySelector(`.draft-card[data-id="${selection.id}"]`);
    if (node) node.classList.add("selected");
  }
  reportUiState();
}

async function canvasApi(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function canvasPatch(url, payload) {
  return canvasApi(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function loadCanvas() {
  try {
    const [arrowsData, notesData, imagesData, draftsData] = await Promise.all([
      canvasApi("/api/canvas/arrows"),
      canvasApi("/api/canvas/notes"),
      canvasApi("/api/canvas/images"),
      canvasApi("/api/canvas/drafts"),
    ]);
    state.arrows = arrowsData.arrows || [];
    state.notes = notesData.notes || [];
    state.images = imagesData.images || [];
    state.drafts = draftsData.drafts || [];
  } catch {
    state.arrows = [];
    state.notes = [];
    state.images = [];
    state.drafts = [];
  }
  drawArrows();
  renderNotes();
  renderImages();
  renderDrafts();
}

/* 按下即创建 → 拖动直线预览 → 松手定弯（<8px 自动取消）→ 建完即编辑文字（Cowart 全套手感） */
function startArrowDraft(event) {
  const start = toWorld(event.clientX, event.clientY);
  const NS = "http://www.w3.org/2000/svg";
  const draft = document.createElementNS(NS, "path");
  draft.setAttribute("class", "arrow-draft");
  draft.setAttribute("stroke", ARROW_COLORS[state.arrowColor] || ARROW_COLORS.red);
  $("arrows").appendChild(draft);
  const move = (moveEvent) => {
    const p = toWorld(moveEvent.clientX, moveEvent.clientY);
    draft.setAttribute("d", `M ${start.x} ${start.y} L ${p.x} ${p.y}`);
  };
  const up = async (upEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    const p = toWorld(upEvent.clientX, upEvent.clientY);
    const len = Math.hypot(p.x - start.x, p.y - start.y);
    if (len < 8 / view.zoom) { draft.remove(); return; }
    draft.remove();
    try {
      const data = await canvasApi("/api/canvas/arrows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x1: start.x, y1: start.y, x2: p.x, y2: p.y, color: state.arrowColor, label: "", doc: state.path }),
      });
      state.arrows.push(data.arrow);
      drawArrows();
      openArrowLabelEditor(data.arrow);
    } catch (err) {
      toast(String(err.message || err));
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function openArrowLabelEditor(arrow) {
  const editor = $("arrow-label-editor");
  const input = $("arrow-label-input");
  editor.hidden = false;
  const screen = (() => {
    const rect = $("viewport").getBoundingClientRect();
    return {
      x: rect.left + view.panX + arrow.x1 * view.zoom,
      y: rect.top + view.panY + arrow.y1 * view.zoom,
    };
  })();
  editor.style.left = `${Math.min(screen.x + 16, window.innerWidth - 280)}px`;
  editor.style.top = `${Math.max(12, Math.min(screen.y - 24, window.innerHeight - 90))}px`;
  input.value = arrow.label || "";
  input.focus();
  input.select();
  const commit = async (keep) => {
    input.removeEventListener("keydown", onKey);
    input.removeEventListener("blur", onBlur);
    editor.hidden = true;
    const label = keep ? input.value.trim() : "";
    if (label !== (arrow.label || "")) {
      arrow.label = label;
      await canvasPatch("/api/canvas/arrows", { id: arrow.id, label });
    }
    drawArrows();
    setTool("select");
  };
  const onKey = (keyEvent) => {
    if (keyEvent.key === "Enter") commit(true);
    if (keyEvent.key === "Escape") commit(false);
  };
  const onBlur = () => commit(true);
  input.addEventListener("keydown", onKey);
  input.addEventListener("blur", onBlur);
}

/* ---------------- 便签 ---------------- */
function renderNotes() {
  const host = $("notes-layer");
  host.innerHTML = "";
  // 历史数据保留在 sidecar 以兼容旧版本，但 v0.9 起不再呈现便签/白板。
}

function noteElement(note) {
  const node = document.createElement("div");
  node.className = note.type === "board" ? "note board" : "note";
  node.dataset.id = note.id;
  node.contentEditable = "false";
  node.dataset.placeholder = note.type === "board" ? "白板 · 随手写想法（不计入 Agent 约束）…" : "写点想法…";
  node.textContent = note.text || "";
  node.style.left = `${note.x}px`;
  node.style.top = `${note.y}px`;
  if (note.type === "board" && !note.w) { node.style.width = "440px"; node.style.minHeight = "300px"; }
  if (state.canvasSelected && state.canvasSelected.type === "note" && state.canvasSelected.id === note.id) {
    node.classList.add("selected");
  }
  const del = document.createElement("button");
  del.className = "note-del";
  del.textContent = "✕";
  del.title = "删除便签";
  del.addEventListener("pointerdown", (event) => event.stopPropagation());
  del.addEventListener("click", async (event) => {
    event.stopPropagation();
    await canvasApi(`/api/canvas/notes?id=${encodeURIComponent(note.id)}`, { method: "DELETE" });
    state.notes = state.notes.filter((item) => item.id !== note.id);
    renderNotes();
    toast("便签已删除");
  });
  node.appendChild(del);

  node.addEventListener("pointerdown", (event) => {
    if (event.target === del || node.isContentEditable) return;
    event.stopPropagation();
    selectCanvas({ type: "note", id: note.id });
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = note.x;
    const originY = note.y;
    node.classList.add("dragging");
    const move = (moveEvent) => {
      note.x = originX + (moveEvent.clientX - startX) / view.zoom;
      note.y = originY + (moveEvent.clientY - startY) / view.zoom;
      node.style.left = `${note.x}px`;
      node.style.top = `${note.y}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      node.classList.remove("dragging");
      canvasPatch("/api/canvas/notes", { id: note.id, x: note.x, y: note.y });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });

  node.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    node.contentEditable = "true";
    node.classList.add("editing");
    node.focus();
  });
  node.addEventListener("blur", async () => {
    node.contentEditable = "false";
    node.classList.remove("editing");
    const clone = node.cloneNode(true); // 剥掉 ✕ 按钮再取正文，防止按钮字符混入便签文本
    clone.querySelectorAll(".note-del").forEach((b) => b.remove());
    const text = clone.textContent.trim().slice(0, 2000);
    if (text !== (note.text || "")) {
      note.text = text;
      await canvasPatch("/api/canvas/notes", { id: note.id, text });
    }
  });
  node.addEventListener("keydown", (event) => {
    if (event.key === "Escape") node.blur();
    event.stopPropagation();
  });
  return node;
}

async function placeNote(event) {
  const p = toWorld(event.clientX, event.clientY);
  try {
    const data = await canvasApi("/api/canvas/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: p.x - 95, y: p.y - 20, text: "", doc: state.path }),
    });
    state.notes.push(data.note);
    renderNotes();
    const node = $("notes-layer").querySelector(`.note[data-id="${data.note.id}"]`);
    if (node) {
      selectCanvas({ type: "note", id: data.note.id });
      node.contentEditable = "true";
      node.classList.add("editing");
      node.focus();
    }
    setTool("select");
  } catch (err) {
    toast(String(err.message || err));
  }
}

/* ---------------- 画布图卡与 HTML 草稿卡 ---------------- */
function cardDrag(node, item) {
  node.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    if (event.target.closest("button, iframe, a")) return;
    event.preventDefault(); // 禁止浏览器原生图片拖影，也阻止兼容 mousedown 带动画布
    event.stopPropagation();
    selectCanvas({ type: item.__type === "images" ? "image" : "draft", id: item.id });
    node.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = item.x;
    const originY = item.y;
    node.classList.add("dragging");
    const move = (moveEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return;
      item.x = originX + (moveEvent.clientX - startX) / view.zoom;
      item.y = originY + (moveEvent.clientY - startY) / view.zoom;
      node.style.left = `${item.x}px`;
      node.style.top = `${item.y}px`;
    };
    const up = (upEvent) => {
      if (upEvent.pointerId !== event.pointerId) return;
      node.removeEventListener("pointermove", move);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointercancel", up);
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      node.classList.remove("dragging");
      canvasPatch("/api/canvas/" + item.__type, { id: item.id, x: item.x, y: item.y });
    };
    node.addEventListener("pointermove", move);
    node.addEventListener("pointerup", up);
    node.addEventListener("pointercancel", up);
  });
}

function renderImages() {
  const host = $("images-layer");
  host.innerHTML = "";
  for (const card of state.images) {
    if (!ownsCanvas(card)) continue;
    const node = document.createElement("div");
    card.__type = "images";
    node.className = "image-card";
    node.dataset.id = card.id;
    node.style.left = `${card.x}px`;
    node.style.top = `${card.y}px`;
    node.style.width = `${card.w}px`;
    if (state.canvasSelected && state.canvasSelected.type === "image" && state.canvasSelected.id === card.id) node.classList.add("selected");
    const url = `/api/raw?p=${encodeURIComponent(card.file)}`;
    const name = card.file.split("/").pop();
    node.innerHTML = `<img src="${url}" alt="" draggable="false" style="width:100%"><div class="ic-tag">${escapeHtml(name)}</div>`;
    const open = document.createElement("button");
    open.className = "ic-open";
    open.textContent = "打开批注";
    open.title = "打开为文档，可框选区域批注";
    open.addEventListener("pointerdown", (event) => event.stopPropagation());
    open.addEventListener("click", (event) => { event.stopPropagation(); openDoc(card.file); });
    node.appendChild(open);
    cardDrag(node, card);
    host.appendChild(node);
  }
}

function renderDrafts() {
  const host = $("drafts-layer");
  host.innerHTML = "";
  for (const card of state.drafts) {
    if (!ownsCanvas(card)) continue;
    const node = document.createElement("div");
    card.__type = "drafts";
    node.className = "draft-card";
    node.dataset.id = card.id;
    node.style.left = `${card.x}px`;
    node.style.top = `${card.y}px`;
    node.style.width = `${card.w}px`;
    if (state.canvasSelected && state.canvasSelected.type === "draft" && state.canvasSelected.id === card.id) node.classList.add("selected");
    const head = document.createElement("div");
    head.className = "dc-head";
    const title = card.title || card.file.split("/").pop();
    head.innerHTML = `<span class="dc-dot" title="Agent 草稿"></span><span>${escapeHtml(title)}</span>`;
    const del = document.createElement("button");
    del.className = "dc-del";
    del.textContent = "✕";
    del.title = "删除草稿卡（文件保留在 vault）";
    del.addEventListener("pointerdown", (event) => event.stopPropagation());
    del.addEventListener("click", async (event) => {
      event.stopPropagation();
      await canvasApi(`/api/canvas/drafts?id=${encodeURIComponent(card.id)}`, { method: "DELETE" });
      state.drafts = state.drafts.filter((item) => item.id !== card.id);
      renderDrafts();
      toast("草稿卡已移除（HTML 文件仍在 vault 内）");
    });
    head.appendChild(del);
    const frame = document.createElement("iframe");
    frame.sandbox = "allow-scripts"; // 无 allow-same-origin：草稿 JS 摸不到父页面与本地存储
    frame.src = `/api/raw?p=${encodeURIComponent(card.file)}`;
    frame.style.height = `${card.h - 30}px`;
    node.appendChild(head);
    node.appendChild(frame);
    cardDrag(node, card);
    host.appendChild(node);
  }
}

/* ---------------- 贴图（拖入 / 粘贴 / 选择文件 → 直接贴到画布） ---------------- */
async function uploadImages(files) {
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const response = await fetch(`/api/asset?dir=assets&name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      body: file,
    });
    const saved = await response.json();
    // 贴到画布视口中心（world 坐标）
    const rect = $("viewport").getBoundingClientRect();
    const center = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const created = await canvasApi("/api/canvas/images", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: saved.rel, x: center.x - 160, y: center.y - 120, w: 320, doc: state.path }),
    });
    state.images.push(created.image);
    renderImages();
    await loadTree();
    toast(`已贴到画布：${saved.rel}（双击图卡可打开为文档框选批注）`);
  }
}

$("file-input").addEventListener("change", (event) => {
  if (event.target.files.length) uploadImages([...event.target.files]);
  event.target.value = "";
  setTool("select");
});

$("viewport").addEventListener("dragover", (event) => event.preventDefault());
$("viewport").addEventListener("drop", (event) => {
  event.preventDefault();
  if (event.dataTransfer && event.dataTransfer.files.length) uploadImages([...event.dataTransfer.files].filter((file) => file.type.startsWith("image/")));
});
window.addEventListener("paste", (event) => {
  const items = event.clipboardData && event.clipboardData.files;
  if (items && items.length) uploadImages([...items].filter((file) => file.type.startsWith("image/")));
});

/* ---------------- 工具条 ---------------- */
function setTool(tool) {
  state.canvasTool = tool;
  document.body.dataset.tool = tool;
  document.querySelectorAll("#toolbox .tool").forEach((node) => node.classList.toggle("active", node.dataset.tool === tool));
  if (tool !== "select") selectCanvas(null);
}

document.querySelectorAll("#toolbox .tool").forEach((button) => {
  button.addEventListener("click", () => {
    const tool = button.dataset.tool;
    if (tool === "image") { $("file-input").click(); return; }
    setTool(state.canvasTool === tool ? "select" : tool);
  });
});
document.querySelectorAll(".swatch").forEach((button) => {
  button.addEventListener("click", () => {
    state.arrowColor = button.dataset.color;
    document.querySelectorAll(".swatch").forEach((node) => node.classList.toggle("active", node === button));
  });
});

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (typing || event.metaKey || event.ctrlKey) return;
  if (event.key === "Escape" && !$("fs-modal").hidden) { $("fs-modal").hidden = true; return; } // 文件夹选择器优先响应 Esc
  if (isCanvasMode() && (event.key === "v" || event.key === "V")) setTool("select");
  if (isCanvasMode() && (event.key === "a" || event.key === "A")) setTool("arrow");
  if (isCanvasMode() && (event.key === "i" || event.key === "I")) $("file-input").click();
  if (isCanvasMode() && (event.key === "r" || event.key === "R")) setTool("region");
  if (event.key === "Escape") { selectCanvas(null); setTool("select"); }
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    const help = $("shortcut-help");
    help.hidden = !help.hidden;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && state.canvasSelected) {
    const sel = state.canvasSelected;
    const endpoints = { arrow: ["arrows", "/api/canvas/arrows", "箭头"], image: ["images", "/api/canvas/images", "图卡"], draft: ["drafts", "/api/canvas/drafts", "草稿卡"] };
    const [listKey, endpoint, label] = endpoints[sel.type] || [];
    if (listKey) {
      canvasApi(`${endpoint}?id=${encodeURIComponent(sel.id)}`, { method: "DELETE" })
        .then(() => {
          state[listKey] = state[listKey].filter((item) => item.id !== sel.id);
          selectCanvas(null);
          drawArrows(); renderNotes(); renderImages(); renderDrafts();
          toast(`${label}已删除`);
        });
    }
  }
});

/* UI 状态上报：MCP get_ui_state 读取（当前文档 / 选中元素 / 视口） */
function reportUiState() {
  const selection = state.canvasSelected
    ? { type: state.canvasSelected.type, id: state.canvasSelected.id }
    : (state.selected ? { type: "annotation", id: state.selected } : null);
  fetch("/api/ui-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: state.path, workspaceMode: state.workspaceMode, editing: document.body.classList.contains("editing-doc"), selected: selection }),
  }).catch(() => {});
}

$("sh-close").addEventListener("click", () => { $("shortcut-help").hidden = true; });
$("shortcut-help").addEventListener("click", (event) => {
  if (event.target === $("shortcut-help")) $("shortcut-help").hidden = true;
});

/* ---------------- 布局 ---------------- */
function tidyLayout() {
  const sorted = [...state.annotations].sort((a, b) => anchorY(a) - anchorY(b));
  let cursor = -Infinity;
  for (const annotation of sorted) {
    const y = Math.max(anchorY(annotation) - 30, cursor + CARD_GAP);
    annotation.x = RAIL_X;
    annotation.y = Math.max(0, y);
    cursor = annotation.y + estimateCardHeight(annotation);
    patch(annotation.id, { x: annotation.x, y: annotation.y, event: "layout" });
  }
  renderCards();
  initialView(); // 回到默认查阅视图：文档顶部 + 卡片一列入镜
  toast("已整理布局");
}

function estimateCardHeight(annotation) {
  const lines = Math.ceil((annotation.body || "").length / 26);
  return 96 + lines * 22;
}

function anchorY(annotation) {
  const mark = findAnchor(annotation.id)
    || $("doc").querySelector(`.region[data-ann="${annotation.id}"]`);
  if (mark) return worldRect(mark).y;
  return annotation.y ?? 0;
}

function freeSpotNear(worldY) {
  const taken = state.annotations
    .filter((item) => Math.abs((item.x ?? RAIL_X) - RAIL_X) < 40)
    .map((item) => ({ top: item.y ?? 0, bottom: (item.y ?? 0) + estimateCardHeight(item) }))
    .sort((a, b) => a.top - b.top);
  let y = Math.max(0, worldY - 30);
  for (const slot of taken) {
    if (y + 120 > slot.top && y < slot.bottom) y = slot.bottom + CARD_GAP;
  }
  return y;
}

/* ---------------- 数据 ---------------- */
async function patch(id, payload) {
  await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, ...payload }),
  });
}

function kindOf(path) {
  if (/\.pdf$/i.test(path)) return "pdf";
  if (/\.docx$/i.test(path)) return "docx";
  if (/\.pptx$/i.test(path)) return "pptx";
  if (/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(path)) return "image";
  return "text";
}

async function waitForPdfRenderer(timeout = 6000) {
  const start = Date.now();
  while (!window.renderPdfToContainer && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return Boolean(window.renderPdfToContainer);
}

async function renderDocument() {
  if (editSession) return; // 编辑态不重渲染，外部修改由保存时 409 提示
  const host = $("doc");
  host.classList.remove("docx-view", "html-view", "pdf-view", "image-view");
  if (state.mode === "pdf") {
    host.classList.add("pdf-view");
    if (!(await waitForPdfRenderer())) {
      host.innerHTML = '<p style="color:#c99537">PDF 渲染器未能加载（离线？）。可用系统预览打开。</p>';
      return;
    }
    try {
      // PDF 宽度自适应纸张（消除横向溢出），支持 1/2/3 列阅读布局
      const cols = state.pdfCols || 1;
      const result = await window.renderPdfToContainer(host, `/api/raw?p=${encodeURIComponent(state.path)}`, { cols });
      state.text = result.text;
      $("docpath").textContent = `${state.path} · ${result.pages} 页 · ${cols} 列`;
      $("bar-pdf-cols").hidden = false;
      document.querySelectorAll("#bar-pdf-cols button").forEach((b) => b.classList.toggle("active", Number(b.dataset.cols) === cols));
    } catch (err) {
      $("bar-pdf-cols").hidden = true;
      host.innerHTML = `<p style="color:#e0604f">PDF 渲染失败：${String(err && err.message || err)}</p>`;
    }
    return;
  }
  $("bar-pdf-cols").hidden = true;
  if (state.mode === "docx") {
    // Word 文档：mammoth 转 HTML 渲染（样式贴近 Word 语义结构），文本可选中批注
    host.innerHTML = '<p style="color:var(--ink-faint)">正在解析 Word 文档…</p>';
    try {
      const buf = await (await fetch(`/api/raw?p=${encodeURIComponent(state.path)}`)).arrayBuffer();
      const result = await window.mammoth.convertToHtml({ arrayBuffer: buf });
      host.innerHTML = result.value || "<p>（空文档）</p>";
      host.classList.add("docx-view");
      state.text = host.innerText;
    } catch (err) {
      host.innerHTML = `<p style="color:#e0604f">Word 解析失败：${String(err && err.message || err)}</p>`;
    }
    return;
  }
  if (state.mode === "pptx") {
    host.innerHTML = `
      <div class="pptx-guide">
        <p class="pg-title">PPT 不在这里渲染 —— 用批注闭环来改它</p>
        <ol class="pg-steps">
          <li><b>把要改的幻灯片截图（或导出 PNG）放进这个文件夹</b>，打开图片用「区域批注」圈出位置、写下要求；批注照常编号并进入约束。</li>
          <li><b>直接对 Agent 说「按批注改这个 PPT」</b>：Agent 读取约束后用脚本改 .pptx（改文字、删页、换图），新版本放在原文件旁边，绝不覆盖原件。</li>
          <li>让 Agent 把改后关键页导出 PNG 放上画布，与原图并排验收。</li>
        </ol>
        <p class="pg-note">不内嵌 PPT 编辑器是刻意取舍：内嵌渲染要引入重量级依赖，且重排版式几乎必然跑版。文字级小修改交给 Agent 更可靠。</p>
      </div>`;
    state.text = "";
    return;
  }
  if (state.mode === "image") {
    host.classList.add("image-view");
    host.innerHTML = `
      <div class="image-stage" id="image-stage">
        <img id="image-node" src="/api/raw?p=${encodeURIComponent(state.path)}" alt="" />
        <div class="region-layer" id="region-layer"></div>
      </div>`;
    return;
  }
  if (/\.html?$/i.test(state.path || "")) {
    host.classList.add("html-view");
    host.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.id = "html-frame";
    frame.title = state.path.split("/").pop() || "HTML 预览";
    frame.sandbox = "allow-same-origin"; // 同源仅用于选择文字；未开放脚本执行
    frame.referrerPolicy = "no-referrer";
    host.appendChild(frame);
    htmlCoedit = buildHtmlCoedit(state.text);
    await new Promise((resolve) => {
      frame.addEventListener("load", () => {
        const resize = () => {
          const inner = frame.contentDocument;
          if (!inner) return;
          frame.style.height = `${Math.max(720, inner.documentElement.scrollHeight, inner.body ? inner.body.scrollHeight : 0)}px`;
        };
        resize();
        if (window.ResizeObserver && frame.contentDocument && frame.contentDocument.body) {
          const observer = new ResizeObserver(resize);
          observer.observe(frame.contentDocument.body);
          frame.__coeditorObserver = observer;
        }
        bindHtmlSelection(frame);
        resolve();
      }, { once: true });
      frame.srcdoc = htmlCoedit.html;
    });
    bindHtmlInlineEdit(frame);
    return;
  }
  htmlCoedit = null;
  host.innerHTML = renderMarkdown(state.text);
}

async function loadAnnotations() {
  if (!state.path) return;
  const [res, roundRes] = await Promise.all([
    fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`),
    fetch("/api/rounds"),
  ]);
  const data = await res.json();
  state.annotations = data.annotations || [];
  if (roundRes.ok) state.round = (await roundRes.json()).activeRound ?? 0;
  await renderDocument();
  const decayed = state.mode === "image" ? 0 : await anchorAll();
  renderRegions();
  bindImageSelection();
  for (const annotation of state.annotations) {
    if (annotation.x === undefined) {
      annotation.x = RAIL_X;
      annotation.y = freeSpotNear(anchorY(annotation));
      patch(annotation.id, { x: annotation.x, y: annotation.y, event: "placed" });
    }
  }
  renderCards();
  applyTransform();
  drawArrows();
  renderNotes();
  renderImages();
  renderDrafts();
  reportUiState();
  if (decayed > 0) toast(`${decayed} 条批注因原文变更已自动降权`);
}

async function openDoc(path, { push = true } = {}) {
  if (editSession) leaveEditUi();
  state.path = path;
  state.mode = kindOf(path);
  if (state.workspaceMode === "edit") state.workspaceMode = "read";
  syncWorkspaceModeUi();
  if (push) history.pushState({ doc: path }, "", `?doc=${encodeURIComponent(path)}`);
  const response = await fetch(`/api/doc?p=${encodeURIComponent(path)}`);
  if (response.ok) {
    const data = await response.json();
    state.text = data.text;
    state.mtime = data.mtime;
  } else {
    state.text = "";
    state.mtime = 0;
  }
  $("docpath").textContent = path;
  document.querySelectorAll("#tree .file").forEach((node) => node.classList.toggle("current", node.dataset.path === path));
  $("empty").style.display = "none";
  $("btn-export").hidden = state.mode !== "image";
  document.querySelectorAll("#tree .file").forEach((node) => node.classList.toggle("current", node.dataset.path === path));
  await loadAnnotations();
  initialView();
}

/* 阅读模式按自然文档流打开；只有画布模式才把页面与卡片一起缩放到世界坐标。 */
function initialView() {
  if (!isCanvasMode()) {
    view.zoom = 1;
    view.panX = 0;
    view.panY = 0;
    applyTransform();
    $("viewport").scrollTo({ top: 0, left: 0 });
    return;
  }
  const rect = $("viewport").getBoundingClientRect();
  const pageW = $("page").offsetWidth || PAGE_W;
  const contentW = pageW + CARD_W + 60;
  let contentH = $("page").offsetHeight || 800;
  for (const item of state.notes) {
    if (ownsCanvas(item)) contentH = Math.max(contentH, (item.y || 0) + 180);
  }
  for (const item of state.images) {
    if (ownsCanvas(item)) contentH = Math.max(contentH, (item.y || 0) + 320);
  }
  for (const item of state.drafts) {
    if (ownsCanvas(item)) contentH = Math.max(contentH, (item.y || 0) + (item.h || 360));
  }
  view.zoom = Math.min((rect.width - 80) / contentW, (rect.height - 80) / contentH, 1);
  view.zoom = Math.max(0.3, view.zoom);
  view.panX = Math.max(24, (rect.width - contentW * view.zoom) / 2);
  view.panY = 40;
  applyTransform();
}

async function loadTree() {
  const res = await fetch("/api/tree");
  const data = await res.json();
  state.vaultRoot = data.root || state.vaultRoot;
  $("vault").textContent = data.root;
  const dot = { text: "#777168", pdf: "#c99537", image: "#6fa055" };
  const storageKey = `coeditor.tree.expanded:${data.root || ""}`;
  let savedExpanded = null;
  try {
    const stored = localStorage.getItem(storageKey);
    savedExpanded = stored ? new Set(JSON.parse(stored)) : null;
  } catch { savedExpanded = null; }
  const render = (nodes, depth) => nodes.map((node) => {
    if (node.type === "dir") {
      const expanded = savedExpanded ? savedExpanded.has(node.path) : depth === 0;
      return `<div class="tree-node${expanded ? " expanded" : ""}" data-dir="${escapeAttr(node.path)}">
        <button class="tree-row dir" type="button" aria-expanded="${expanded}" style="--depth:${depth}" title="${escapeAttr(node.path)}">
          <span class="twistie">›</span><span class="folder-icon"></span><span class="tree-name">${escapeHtml(node.name)}</span>
        </button>
        <div class="tree-children">${render(node.children || [], depth + 1)}</div>
      </div>`;
    }
    return `<button class="tree-row file" type="button" data-path="${escapeAttr(node.path)}" title="${escapeAttr(node.path)}" style="--depth:${depth}"><i style="background:${dot[node.kind] || dot.text}"></i><span class="tree-name">${escapeHtml(node.name)}</span></button>`;
  }).join("");
  $("tree").innerHTML = render(data.tree, 0);
  const saveExpanded = () => {
    const dirs = [...$("tree").querySelectorAll(".tree-node.expanded")].map((node) => node.dataset.dir);
    localStorage.setItem(storageKey, JSON.stringify(dirs));
  };
  $("tree").querySelectorAll(".tree-node > .dir").forEach((row) => {
    row.addEventListener("click", () => {
      const node = row.parentElement;
      const expanded = node.classList.toggle("expanded");
      row.setAttribute("aria-expanded", String(expanded));
      saveExpanded();
    });
  });
  $("tree").querySelectorAll(".file").forEach((node) => {
    node.addEventListener("click", () => openDoc(node.dataset.path));
  });
  const current = state.path && $("tree").querySelector(`.file[data-path="${CSS.escape(state.path)}"]`);
  if (current) {
    current.classList.add("current");
    let parent = current.parentElement;
    while (parent && parent !== $("tree")) {
      if (parent.classList.contains("tree-node")) {
        parent.classList.add("expanded");
        const row = parent.querySelector(":scope > .dir");
        if (row) row.setAttribute("aria-expanded", "true");
      }
      parent = parent.parentElement;
    }
  }
}

/* ---------------- 选区批注 ---------------- */
let pending = null;

/* 选区动作菜单：批注 / 高亮 / 删除线（参考 Obsidian Selection Toolbar 的交互） */
function showSelMenu(rect) {
  const menu = $("sel-menu");
  menu.hidden = false;
  const top = Math.max(8, rect.top - 44);
  menu.style.top = `${top}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}
function hideSelMenu() { $("sel-menu").hidden = true; }

function captureTextSelection(root, selection, rectOffset = { left: 0, top: 0 }) {
  if (state.mode === "image") return; // 图片走区域框选，不参与文字选区
  if (state.canvasTool === "region") return; // 区域工具拖框中：不触发文字浮条（且不 stopPropagation 挡掉 region 的 mouseup 监听）
  if (document.body.classList.contains("editing-doc")) return; // 编辑态由 textarea 自己处理
  const text = String(selection).trim();
  if (!text || !root.contains(selection.anchorNode) || !selection.rangeCount) { hideSelMenu(); return; }
  const range = selection.getRangeAt(0);
  const owner = root.ownerDocument || document;
  const before = owner.createRange();
  before.setStart(root, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = owner.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(root, root.childNodes.length);
  const innerRect = range.getBoundingClientRect();
  const rect = {
    left: innerRect.left + rectOffset.left,
    right: innerRect.right + rectOffset.left,
    top: innerRect.top + rectOffset.top,
    bottom: innerRect.bottom + rectOffset.top,
    width: innerRect.width,
    height: innerRect.height,
  };
  pending = {
    quote: text,
    prefix: String(before).slice(-40),
    suffix: String(after).slice(0, 40),
    worldY: toWorld(rect.left, rect.top).y,
    clientRect: rect,
  };
  showSelMenu(rect);
}

$("page").addEventListener("mouseup", (event) => {
  captureTextSelection($("doc"), window.getSelection());
  if (pending) event.stopPropagation(); // 只有真弹出浮条才拦截冒泡；region 拖框等流程的 window 级 mouseup 监听必须能收到
});

function bindHtmlSelection(frame) {
  const inner = frame.contentDocument;
  if (!inner || !inner.body) return;
  inner.addEventListener("mouseup", () => {
    const frameRect = frame.getBoundingClientRect();
    captureTextSelection(inner.body, frame.contentWindow.getSelection(), { left: frameRect.left, top: frameRect.top });
  });
  inner.addEventListener("mousedown", () => hideSelMenu());
}

function clearTextSelections() {
  window.getSelection().removeAllRanges();
  const frame = $("html-frame");
  if (frame && frame.contentWindow) frame.contentWindow.getSelection().removeAllRanges();
}

/* 从源文件构建双树：original 保真写回；preview 中和脚本 + 改写资源 + 标注 coedit 路径 */
function buildHtmlCoedit(source) {
  const original = new DOMParser().parseFromString(source, "text/html");
  const preview = new DOMParser().parseFromString(source, "text/html");
  preview.querySelectorAll("script").forEach((node) => {
    const holder = preview.createElement("template");
    holder.setAttribute("data-coeditor-script", "neutralized");
    node.replaceWith(holder); // 占位保结构，脚本不执行
  });
  preview.querySelectorAll("*").forEach((node) => {
    for (const attr of [...node.attributes]) {
      if (/^on/i.test(attr.name) || attr.name === "data-coedit") node.removeAttribute(attr.name);
    }
    for (const name of ["src", "href", "poster"]) {
      if (node.hasAttribute(name)) node.setAttribute(name, htmlAssetUrl(node.getAttribute(name)));
    }
    if (node.hasAttribute("srcset")) {
      node.setAttribute("srcset", node.getAttribute("srcset").split(",").map((part) => {
        const [url, descriptor] = part.trim().split(/\s+/, 2);
        return `${htmlAssetUrl(url)}${descriptor ? ` ${descriptor}` : ""}`;
      }).join(", "));
    }
    if (node.hasAttribute("style")) node.setAttribute("style", rewriteCssAssets(node.getAttribute("style")));
  });
  preview.querySelectorAll("style").forEach((node) => { node.textContent = rewriteCssAssets(node.textContent); });
  const map = new Map();
  assignCoeditIds(preview.documentElement, original.documentElement, "0", map);
  const guard = preview.createElement("style");
  guard.textContent = `html{background:#fff;color-scheme:light} body{min-height:100vh}
    ::selection{background:rgba(239,107,78,.24)}
    .anchor{background:rgba(239,107,78,.16);box-shadow:inset 0 -2px 0 rgba(239,107,78,.72);border-radius:2px;cursor:pointer}
    .anchor[data-kind="highlight"]{background:rgba(246,211,91,.44);box-shadow:none}
    .anchor[data-kind="strike"]{background:rgba(239,107,78,.08);box-shadow:none;text-decoration:line-through;text-decoration-color:rgba(220,83,64,.9);text-decoration-thickness:2px}
    .anchor[data-status="deprecated"]{opacity:.45}`;
  preview.head.appendChild(guard);
  return { html: `<!doctype html>${preview.documentElement.outerHTML}`, original, map };
}

function htmlPreviewOnly(source) {
  return buildHtmlCoedit(source).html;
}

/* 点击元素直接改文字：双击纯文本元素 → 浮动编辑面板 → 保存映射回 original 树写回源文件 */
let htmlEditTarget = null;

function bindHtmlInlineEdit(frame) {
  const inner = frame.contentDocument;
  if (!inner || !inner.body) return;
  inner.addEventListener("dblclick", (event) => {
    if (state.workspaceMode !== "read") return;
    // target 可能是渲染后插入的 mark.anchor（无 data-coedit）——向上爬到最近的映射祖先
    let mapped = event.target;
    while (mapped && mapped.nodeType === 1 && !mapped.getAttribute("data-coedit")) mapped = mapped.parentElement;
    if (!mapped || mapped === inner.documentElement) { toast("这里不支持直接改文字"); return; }
    let editable = null;
    let cursor = mapped;
    for (let hop = 0; cursor && cursor.nodeType === 1 && hop < 5; hop += 1) {
      const kids = [...cursor.childNodes];
      const plain = kids.length > 0 && kids.every((n) => n.nodeType === 3 || (n.nodeType === 1 && n.matches("mark.anchor")));
      if (plain) { editable = cursor; break; }
      const down = [...cursor.children].find((c) => c === event.target || c.contains(event.target));
      if (down && down !== cursor) { cursor = down; continue; }
      break;
    }
    hideSelMenu();
    pending = null;
    clearTextSelections();
    if (!editable || !editable.getAttribute("data-coedit") || !editable.textContent.trim()) {
      toast("这里含嵌套结构，改文字请切「编辑」模式用源码");
      return;
    }
    htmlEditTarget = editable;
    const text = editable.textContent;
    $("html-edit-tag").textContent = `<${editable.tagName.toLowerCase()}>`;
    $("html-edit-input").value = text;
    const panel = $("html-edit");
    panel.hidden = false;
    panel.style.top = `${Math.min(event.clientY + 12, window.innerHeight - 200)}px`;
    panel.style.left = `${Math.min(event.clientX, window.innerWidth - 390)}px`;
    $("html-edit-input").focus();
  });
}

function closeHtmlEdit() {
  $("html-edit").hidden = true;
  htmlEditTarget = null;
}

$("html-edit-close").addEventListener("click", closeHtmlEdit);
$("html-edit-cancel").addEventListener("click", closeHtmlEdit);

$("html-edit-save").addEventListener("click", async () => {
  if (!htmlEditTarget || !htmlCoedit) return;
  const path = htmlEditTarget.getAttribute("data-coedit");
  const originalEl = htmlCoedit.map.get(path);
  const nextText = $("html-edit-input").value;
  if (!originalEl) { toast("映射已失效，请刷新后重试"); closeHtmlEdit(); return; }
  if (originalEl.textContent === nextText) { closeHtmlEdit(); return; }
  originalEl.textContent = nextText;
  const next = `<!doctype html>${htmlCoedit.original.documentElement.outerHTML}`;
  const res = await fetch(`/api/write?p=${encodeURIComponent(state.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: next, baseMtime: state.mtime }),
  });
  if (res.status === 409) { toast("文件已被外部修改，请刷新后重试"); closeHtmlEdit(); return; }
  if (!res.ok) { toast("保存失败"); closeHtmlEdit(); return; }
  const data = await res.json();
  state.text = next;
  state.mtime = data.mtime;
  closeHtmlEdit();
  await loadAnnotations();
  toast("已写回源文件，批注重新锚定");
});

document.addEventListener("mousedown", (event) => {
  const menu = $("sel-menu");
  if (!menu.hidden && !menu.contains(event.target)) hideSelMenu();
  const viewMenu = $("view-menu");
  if (viewMenu && viewMenu.open && !viewMenu.contains(event.target)) viewMenu.open = false;
  const pop = $("new-file-pop");
  if (pop && !pop.hidden && !pop.contains(event.target) && event.target !== $("btn-new-file")) pop.hidden = true;
});

$("sel-menu").addEventListener("mousedown", (event) => event.stopPropagation());
$("sel-menu").addEventListener("click", async (event) => {
  const action = event.target.dataset && event.target.dataset.selAct;
  if (!action || !pending) return;
  hideSelMenu();
  if (action === "comment") { openComposer(); return; }
  const kind = action === "highlight" ? "highlight" : "strike";
  const y = freeSpotNear(pending.worldY);
  await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind, quote: pending.quote, prefix: pending.prefix, suffix: pending.suffix,
      body: "", x: RAIL_X, y, round: state.round ?? 0,
    }),
  });
  const quote = pending.quote;
  pending = null;
  clearTextSelections();
  await loadAnnotations();
  toast(kind === "highlight" ? `已保留「${quote.slice(0, 18)}…」` : `已标记删除线「${quote.slice(0, 18)}…」`);
});

function openComposer() {
  if (!pending) return;
  const composer = $("composer");
  const rect = pending.clientRect || (window.getSelection().rangeCount ? window.getSelection().getRangeAt(0).getBoundingClientRect() : { bottom: 200, left: 200 });
  composer.hidden = false;
  composer.style.top = `${Math.min(rect.bottom + 10, window.innerHeight - 220)}px`;
  composer.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
  $("composer-quote").textContent = `“${pending.quote.slice(0, 90)}”`;
  $("composer-input").focus();
}

$("composer-cancel").addEventListener("click", closeComposer);

function closeComposer() {
  $("composer").hidden = true;
  $("composer-input").value = "";
  pending = null;
  clearTextSelections();
}

async function saveAnnotation() {
  if (!pending) return;
  const body = $("composer-input").value.trim();
  if (!body) return;
  const y = freeSpotNear(pending.worldY);
  await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quote: pending.quote,
      prefix: pending.prefix,
      suffix: pending.suffix,
      body,
      x: RAIL_X,
      y,
      kind: pending.kind || "text-quote",
      region: pending.region || null,
      image: pending.image || null,
      round: state.round ?? 0,
    }),
  });
  closeComposer();
  await loadAnnotations();
  toast("批注已保存，编号永久保留");
}

$("composer-save").addEventListener("click", saveAnnotation);
$("composer-input").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveAnnotation();
  if (event.key === "Escape") closeComposer();
});

/* ---------------- 文本编辑模式（Markdown / HTML 源码） ---------------- */
let editSession = null; // { textarea, bar, baseMtime }

function htmlSourceNeedles(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const escaped = raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return [...new Set([raw, escaped])];
}

function nearestSourceOccurrence(source, needles, nearIndex) {
  let best = null;
  for (const needle of needles) {
    let index = source.indexOf(needle);
    while (index >= 0) {
      const candidate = { index, length: needle.length, distance: Math.abs(index - nearIndex) };
      if (!best || candidate.distance < best.distance) best = candidate;
      index = source.indexOf(needle, index + Math.max(1, needle.length));
    }
  }
  return best;
}

function sourceOpeningTagIndex(source, element) {
  if (!element || !element.tagName) return -1;
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute("id");
  if (id) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exact = new RegExp(`<${tag}\\b[^>]*\\bid=["']${escapedId}["'][^>]*>`, "i").exec(source);
    if (exact) return exact.index;
  }
  const doc = element.ownerDocument;
  const ordinal = [...doc.querySelectorAll(tag)].indexOf(element);
  if (ordinal < 0) return -1;
  const matcher = new RegExp(`<${tag}(?=[\\s>/])`, "ig");
  let match; let seen = -1;
  while ((match = matcher.exec(source))) {
    seen += 1;
    if (seen === ordinal) return match.index;
  }
  return -1;
}

function flashCodeMirrorLine(cm, line) {
  cm.addLineClass(line, "background", "coeditor-source-flash");
  clearTimeout(cm.__coeditorFlashTimer);
  cm.__coeditorFlashTimer = setTimeout(() => cm.removeLineClass(line, "background", "coeditor-source-flash"), 1000);
}

function revealPreviewInSource(cm, frame, target, selectedText = "") {
  const source = cm.getValue();
  const cursorIndex = cm.indexFromPos(cm.getCursor());
  const selectionHit = nearestSourceOccurrence(source, htmlSourceNeedles(selectedText), cursorIndex);
  if (selectionHit) {
    const from = cm.posFromIndex(selectionHit.index);
    const to = cm.posFromIndex(selectionHit.index + selectionHit.length);
    cm.setSelection(from, to);
    cm.scrollIntoView({ from, to }, 100);
    flashCodeMirrorLine(cm, from.line);
    cm.focus();
    return true;
  }
  let mapped = target && target.nodeType === 1 ? target : target?.parentElement;
  while (mapped && mapped !== frame.contentDocument.documentElement && !mapped.hasAttribute("data-coedit")) mapped = mapped.parentElement;
  const index = sourceOpeningTagIndex(source, mapped);
  if (index < 0) return false;
  const pos = cm.posFromIndex(index);
  cm.setCursor(pos);
  cm.scrollIntoView(pos, 100);
  flashCodeMirrorLine(cm, pos.line);
  cm.focus();
  return true;
}

function bindHtmlPreviewSourceSync(cm, frame) {
  const bind = () => {
    const inner = frame.contentDocument;
    if (!inner || inner.documentElement.dataset.coeditorSourceSync === "1") return;
    inner.documentElement.dataset.coeditorSourceSync = "1";
    inner.addEventListener("mouseup", (event) => {
      const selected = String(frame.contentWindow.getSelection()).trim();
      if (selected) revealPreviewInSource(cm, frame, event.target, selected);
    });
    inner.addEventListener("click", (event) => {
      event.preventDefault(); // 成品区用于定位源码：链接跳转与表单提交一律拦下，防止预览被自己导航走
      if (String(frame.contentWindow.getSelection()).trim()) return;
      revealPreviewInSource(cm, frame, event.target);
    });
  };
  frame.addEventListener("load", bind);
  if (frame.contentDocument?.readyState === "complete") bind();
}

$("page").addEventListener("dblclick", (event) => {
  if (!isEditableDocument()) return;
  if (document.body.classList.contains("editing-doc")) return;
  if (event.target.closest(".card") || event.target.closest("figure")) return;
  setWorkspaceMode("edit");
});

function syncWorkspaceModeUi() {
  document.body.dataset.workspaceMode = state.workspaceMode;
  document.querySelectorAll("#workspace-modes [data-workspace-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.workspaceMode === state.workspaceMode);
    if (button.dataset.workspaceMode === "edit") {
      button.disabled = !isEditableDocument();
      button.title = isEditableDocument() ? "编辑 Markdown / HTML 源码" : "此格式目前只读；可在画布中批注";
    }
  });
  $("btn-fit").textContent = isCanvasMode() ? "显示全部" : "适合宽度";
  $("btn-layout").disabled = !isCanvasMode();
  $("btn-lines").disabled = !isCanvasMode();
}

async function setWorkspaceMode(mode) {
  if (mode === "edit" && !isEditableDocument()) {
    toast("这种格式目前只读；Markdown、HTML、TXT、JSON、CSV 可以直接编辑");
    return;
  }
  if (mode === state.workspaceMode && (mode !== "edit" || editSession)) return;
  if (editSession && mode !== "edit") leaveEditUi();
  state.workspaceMode = mode;
  if (mode !== "canvas") setTool("select");
  syncWorkspaceModeUi();
  if (mode === "edit") {
    view.zoom = 1;
    applyTransform();
    enterEditMode();
    return;
  }
  if (!editSession) await loadAnnotations();
  initialView();
}

$("workspace-modes").addEventListener("click", (event) => {
  const button = event.target.closest("[data-workspace-mode]");
  if (button && !button.disabled) setWorkspaceMode(button.dataset.workspaceMode);
});

function enterEditMode() {
  if (editSession) return;
  const doc = $("doc");
  const holder = document.createElement("div");
  holder.id = "md-editor";
  doc.innerHTML = "";
  doc.appendChild(holder);
  document.body.classList.add("editing-doc");
  hideSelMenu();
  const bar = document.createElement("div");
  bar.id = "edit-bar";
  bar.innerHTML = `
    <span class="eb-hint">${/\.html?$/i.test(state.path || "") ? "左侧源码 · 右侧成品（点或拖选成品可定位源码）" : "编辑模式 · Markdown / 文本"} · 保存后批注自动重新锚定</span>
    <button id="edit-save" class="primary">保存 ⌘S</button>
    <button id="edit-cancel" class="ghost">返回阅读</button>`;
  $("page").prepend(bar);
  $("edit-save").addEventListener("click", saveEdit);
  $("edit-cancel").addEventListener("click", () => setWorkspaceMode("read"));
  let previewFrame = null;
  let previewTimer = null;
  const isHtmlEdit = /\.html?$/i.test(state.path || "");
  if (isHtmlEdit) {
    const split = document.createElement("div");
    split.className = "edit-split";
    const cmPane = document.createElement("div");
    cmPane.className = "cm-pane";
    const previewPane = document.createElement("div");
    previewPane.className = "preview-pane";
    previewFrame = document.createElement("iframe");
    previewFrame.className = "edit-preview";
    previewFrame.sandbox = "allow-same-origin";
    previewPane.appendChild(previewFrame);
    split.appendChild(cmPane);
    split.appendChild(previewPane);
    holder.appendChild(split);
    holder.classList.add("splitting");
  }
  const cm = CodeMirror(isHtmlEdit ? holder.querySelector(".cm-pane") : holder, {
    value: state.text,
    mode: /\.(html?|json)$/i.test(state.path || "") ? (/\.html?$/i.test(state.path || "") ? "htmlmixed" : { name: "javascript", json: true }) : "markdown",
    lineNumbers: true,
    lineWrapping: true,
    styleActiveLine: true,
    viewportMargin: 10,
    extraKeys: {
      "Cmd-S": saveEdit, "Ctrl-S": saveEdit,
      "Cmd-F": "findPersistent", "Ctrl-F": "findPersistent",
    },
  });
  cm.focus();
  // 容器刚重建时布局未稳定，CM 需要手动 refresh 才会绘制内容
  cm.refresh();
  setTimeout(() => cm.refresh(), 80);
  if (isHtmlEdit && previewFrame) {
    const renderPreview = () => { previewFrame.srcdoc = htmlPreviewOnly(cm.getValue()); };
    bindHtmlPreviewSourceSync(cm, previewFrame);
    renderPreview();
    cm.on("change", () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(renderPreview, 500);
    });
  }
  editSession = { cm, baseMtime: state.mtime };
}

async function saveEdit() {
  if (!editSession) return;
  const res = await fetch(`/api/write?p=${encodeURIComponent(state.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: editSession.cm.getValue(), baseMtime: editSession.baseMtime }),
  });
  if (res.status === 409) {
    toast("文件已被外部修改，请「返回阅读」后重新进入编辑");
    const fresh = await (await fetch(`/api/doc?p=${encodeURIComponent(state.path)}`)).json();
    editSession.baseMtime = fresh.mtime;
    return;
  }
  if (!res.ok) { toast("保存失败： " + (await res.json().catch(() => ({}))).error); return; }
  const data = await res.json();
  state.mtime = data.mtime;
  state.text = editSession.cm.getValue(); // 同步内存文本，loadAnnotations 重渲染才用新内容
  toast("已保存，批注正在重新锚定");
  leaveEditUi();
  state.workspaceMode = "read";
  syncWorkspaceModeUi();
  await loadAnnotations();
  initialView();
}

function leaveEditUi() {
  if (!editSession) return;
  editSession = null;
  document.body.classList.remove("editing-doc");
  const bar = $("edit-bar");
  if (bar) bar.remove();
}

/* PDF 列布局切换（1/2/3 列，像正常阅读 PDF 一样展开） */
$("bar-pdf-cols").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-cols]");
  if (!button || !state.path || state.mode !== "pdf") return;
  state.pdfCols = Number(button.dataset.cols);
  await loadAnnotations(); // 重渲染 + 批注重锚定（文本层重建）
});

/* ---------------- PDF 区域框选（苹果预览式）：区域工具 + 拖拽画框 ---------------- */
function startPdfRegionDraft(event) {
  const pageEl = event.target.closest(".pdf-page");
  if (!pageEl) return;
  event.preventDefault(); // 阻止浏览器启动文字选择——否则拖框会同时选字、触发浮条流
  const viewport = $("viewport");
  const vpRect = viewport.getBoundingClientRect();
  const pageRect = pageEl.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const draft = document.createElement("div");
  draft.className = "region-draft";
  viewport.appendChild(draft);
  const move = (moveEvent) => {
    const x1 = Math.min(startX, moveEvent.clientX) - vpRect.left;
    const y1 = Math.min(startY, moveEvent.clientY) - vpRect.top;
    const x2 = Math.max(startX, moveEvent.clientX) - vpRect.left;
    const y2 = Math.max(startY, moveEvent.clientY) - vpRect.top;
    draft.style.left = `${x1}px`;
    draft.style.top = `${y1}px`;
    draft.style.width = `${x2 - x1}px`;
    draft.style.height = `${y2 - y1}px`;
  };
  const up = (upEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    draft.remove();
    // clamp 到页面矩形内，归一化为页相对坐标（缩放/平移无关，列切换重渲染后自动复位）
    const rx1 = Math.max(pageRect.left, Math.min(startX, upEvent.clientX));
    const ry1 = Math.max(pageRect.top, Math.min(startY, upEvent.clientY));
    const rx2 = Math.min(pageRect.right, Math.max(startX, upEvent.clientX));
    const ry2 = Math.min(pageRect.bottom, Math.max(startY, upEvent.clientY));
    const w = rx2 - rx1;
    const h = ry2 - ry1;
    if (w < 12 || h < 12) return;
    const pageNo = Number(pageEl.dataset.page);
    const region = {
      page: pageNo,
      x: (rx1 - pageRect.left) / pageRect.width,
      y: (ry1 - pageRect.top) / pageRect.height,
      w: w / pageRect.width,
      h: h / pageRect.height,
    };
    pending = {
      kind: "region",
      quote: `第 ${pageNo} 页 区域 (${region.x.toFixed(2)}, ${region.y.toFixed(2)})`,
      prefix: "",
      suffix: "",
      region,
      worldY: toWorld(rx1 + w / 2, ry1 + h / 2).y,
    };
    const composer = $("composer");
    composer.hidden = false;
    composer.style.top = `${Math.min(upEvent.clientY + 12, window.innerHeight - 220)}px`;
    composer.style.left = `${Math.min(upEvent.clientX, window.innerWidth - 360)}px`;
    $("composer-quote").textContent = `框选第 ${pageNo} 页区域 · 宽 ${Math.round(region.w * 100)}% × 高 ${Math.round(region.h * 100)}%`;
    $("composer-input").focus();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/* ---------------- 画布交互 ---------------- */
$("viewport").addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  if (!isCanvasMode()) return;
  // PDF 区域框选（苹果预览式）：区域工具激活时，落在 PDF 页上的拖拽画框选批注
  if (state.canvasTool === "region" && event.target.closest(".pdf-page")) { startPdfRegionDraft(event); return; }
  if (event.target.closest(".card, .image-card, .draft-card") || event.target.closest("#page") || event.target.closest("#composer") || event.target.closest(".note") || event.target.closest(".arrow-g")) return;
  if (state.canvasTool === "arrow") { startArrowDraft(event); return; }
  if (state.canvasTool === "image") { $("file-input").click(); return; }
  if (!event.target.closest("#toolbox")) selectCanvas(null);
  const startX = event.clientX;
  const startY = event.clientY;
  const originX = view.panX;
  const originY = view.panY;
  $("viewport").classList.add("panning");
  const move = (moveEvent) => {
    view.panX = originX + (moveEvent.clientX - startX);
    view.panY = originY + (moveEvent.clientY - startY);
    applyTransform();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    $("viewport").classList.remove("panning");
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

$("viewport").addEventListener("wheel", (event) => {
  if (!isCanvasMode() && !(event.ctrlKey || event.metaKey)) return;
  event.preventDefault();
  if (event.ctrlKey || event.metaKey) {
    zoomAt(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX, event.clientY);
  } else {
    view.panX -= event.deltaX;
    view.panY -= event.deltaY;
    applyTransform();
  }
}, { passive: false });

$("btn-in").addEventListener("click", () => {
  const rect = $("viewport").getBoundingClientRect();
  zoomAt(1.15, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
$("btn-out").addEventListener("click", () => {
  const rect = $("viewport").getBoundingClientRect();
  zoomAt(1 / 1.15, rect.left + rect.width / 2, rect.top + rect.height / 2);
});
$("btn-fit").addEventListener("click", fit);
$("btn-layout").addEventListener("click", tidyLayout);
$("btn-theme").addEventListener("click", () => {
  document.body.classList.toggle("paper-dark");
  $("btn-theme").textContent = document.body.classList.contains("paper-dark") ? "纸张：暗色" : "纸张：明亮";
});
$("btn-focus").addEventListener("click", (event) => {
  const el = event.currentTarget;
  const next = el.dataset.on === "1" ? "2" : el.dataset.on === "2" ? "0" : "1";
  el.dataset.on = next;
  document.body.classList.toggle("focus-active", next === "1");
  document.body.classList.toggle("round-only", next === "2");
  el.textContent = next === "1" ? "批注：当前" : next === "2" ? "批注：本轮" : "批注：全部";
});
$("btn-lines").addEventListener("click", (event) => {
  const on = event.currentTarget.dataset.on === "1";
  event.currentTarget.dataset.on = on ? "0" : "1";
  document.body.classList.toggle("lines-quiet", !on);
  event.currentTarget.textContent = on ? "连接线：显示" : "连接线：自动";
  drawLines();
});
$("rail-toggle").addEventListener("click", () => {
  document.body.classList.toggle("rail-hidden");
  setTimeout(applyTransform, 240);
});

/* 侧栏像编辑器一样可拖动，宽度只保存在本机浏览器。 */
const savedRailWidth = Number(localStorage.getItem("coeditor.railWidth"));
if (Number.isFinite(savedRailWidth)) document.documentElement.style.setProperty("--rail-width", `${Math.min(480, Math.max(220, savedRailWidth))}px`);
$("rail-resizer").addEventListener("pointerdown", (event) => {
  if (document.body.classList.contains("rail-hidden")) return;
  event.preventDefault();
  $("rail-resizer").setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-rail");
  const move = (moveEvent) => {
    const width = Math.min(480, Math.max(220, moveEvent.clientX));
    document.documentElement.style.setProperty("--rail-width", `${width}px`);
    localStorage.setItem("coeditor.railWidth", String(Math.round(width)));
    applyTransform();
  };
  const up = () => {
    $("rail-resizer").removeEventListener("pointermove", move);
    $("rail-resizer").removeEventListener("pointerup", up);
    $("rail-resizer").removeEventListener("pointercancel", up);
    document.body.classList.remove("resizing-rail");
  };
  $("rail-resizer").addEventListener("pointermove", move);
  $("rail-resizer").addEventListener("pointerup", up);
  $("rail-resizer").addEventListener("pointercancel", up);
});

/* ---------------- 约束清单抽屉 ---------------- */
function constraintsText() {
  const round = state.round ?? 0;
  const roundOf = (item) => Number.isFinite(item.round) ? item.round : 0;
  const active = state.annotations.filter((item) => item.status === "active");
  const current = active.filter((item) => roundOf(item) === round).sort((a, b) => b.weight - a.weight);
  const older = active.filter((item) => roundOf(item) !== round).sort((a, b) => roundOf(b) - roundOf(a) || b.weight - a.weight);
  // 画布只保留箭头；便签/白板已从产品交互中移除。
  const canvasArrows = state.arrows.filter((item) => ownsCanvas(item) && (item.label || "").trim());
  const noOf = (item) => item.no || item.id;
  const KIND_LINE = {
    highlight: (item) => `- [${noOf(item)}·保留]「${item.quote.slice(0, 60)}」\n  （人标记保留：这段内容很好，必须保留，不要改写删除）`,
    strike: (item) => `- [${noOf(item)}·删除线]「${item.quote.slice(0, 60)}」\n  （人标记删除线：建议删除或重写此段）`,
  };
  const annLine = (item) => {
    if (KIND_LINE[item.kind]) return KIND_LINE[item.kind](item);
    return [
      `- [${noOf(item)}] w=${Number(item.weight ?? 1).toFixed(2)} 「${item.quote.slice(0, 60)}」`,
      `  ${item.body}`,
      ...(item.conflicts_with || []).length ? [`  ⚠ 与 ${item.conflicts_with.map(noOf).join("/")} 冲突，未经裁定前先询问用户`] : [],
    ];
  };
  const lines = [
    `# ${state.path} · 修改前必读的人类约束`,
    "",
    `## 第 ${round} 批次（本轮 · 进行中）· ${current.length} 条`,
    "",
    ...current.flatMap(annLine),
  ];
  if (older.length) {
    lines.push("", `## 历史批次（仍需参考的旧约束）· ${older.length} 条`, "");
    lines.push(...older.flatMap(annLine));
  }
  if (canvasArrows.length) {
    lines.push("", `## 画布手写（同属人类意图）`, "");
    lines.push(...canvasArrows.map((item) => `- [${item.id}·箭头]「${item.label.trim()}」\n  （人在画布上手写的视觉指令）`).flat());
  }
  return lines.join("\n");
}

function renderDrawer() {
  const round = state.round ?? 0;
  const roundOf = (item) => Number.isFinite(item.round) ? item.round : 0;
  const all = state.annotations.slice().sort((a, b) => roundOf(b) - roundOf(a) || (b.weight - a.weight));
  const groups = new Map();
  for (const item of all) {
    const r = roundOf(item);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(item);
  }
  const itemHtml = (item) => `
    <div class="d-item" data-id="${item.id}" data-status="${item.status}">
      <div class="d-item-head">
        <span class="c-id">${item.no || item.id}</span>
        ${item.kind === "highlight" ? '<span class="c-kind hl">保留</span>' : item.kind === "strike" ? '<span class="c-kind st">删除线</span>' : ""}
        ${item.status === "active" ? '<i class="live-dot" title="当前使用"></i>' : `<span class="c-badge">${LABELS[item.status] || item.status}</span>`}
        <span class="c-weight">${weightDots(item.weight)}</span>
      </div>
      ${item.body ? `<div class="d-item-body">${escapeHtml(item.body)}</div>` : ""}
      <div class="d-item-quote">「${escapeHtml(item.quote.slice(0, 50))}」</div>
      <div class="d-actions">
        ${item.kind === "highlight" ? "" : '<button data-d-act="edit">编辑</button>'}
        <button data-d-act="delete" class="danger">${item.kind === "highlight" ? "取消保留" : "删除"}</button>
      </div>
    </div>`;
  let html = "";
  for (const [r, items] of groups) {
    html += `<div class="d-round">${r === round ? `第 ${r} 批次 · 进行中` : `第 ${r} 批次 · 历史`}</div>`;
    html += items.map(itemHtml).join("");
  }
  $("drawer-body").innerHTML = html || '<div class="d-empty">还没有批注 —— 选中文字开始第一条</div>';
}

$("btn-export").addEventListener("click", () => exportAnnotatedImage());
$("btn-edit-ask").addEventListener("click", askEditWithAnnotations);
$("btn-drawer").addEventListener("click", () => {
  renderDrawer();
  $("drawer").hidden = !$("drawer").hidden;
});
$("drawer-body").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-d-act]");
  if (!button) return;
  const row = button.closest(".d-item");
  const item = state.annotations.find((entry) => entry.id === row.dataset.id);
  if (!item) return;
  if (button.dataset.dAct === "delete") {
    const res = await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id }),
    });
    if (!res.ok) return toast("删除失败，批注未改变");
    await loadAnnotations();
    renderDrawer();
    toast(item.kind === "highlight" ? "已取消保留" : "批注已删除（写前备份已保留）");
    return;
  }
  if (button.dataset.dAct === "edit") {
    const body = row.querySelector(".d-item-body");
    const textarea = document.createElement("textarea");
    textarea.className = "drawer-edit";
    textarea.value = item.body || "";
    if (body) body.replaceWith(textarea); else row.querySelector(".d-item-quote").before(textarea);
    row.querySelector(".d-actions").innerHTML = '<button data-d-act="save">保存</button><button data-d-act="cancel">取消</button>';
    textarea.focus();
    return;
  }
  if (button.dataset.dAct === "cancel") { renderDrawer(); return; }
  if (button.dataset.dAct === "save") {
    const textarea = row.querySelector(".drawer-edit");
    if (!textarea || !textarea.value.trim()) return toast("批注内容不能为空");
    await patch(item.id, { body: textarea.value.trim(), event: "edited" });
    await loadAnnotations();
    renderDrawer();
    toast("批注已更新");
  }
});
$("drawer-close").addEventListener("click", () => { $("drawer").hidden = true; });
$("drawer-copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(constraintsText());
    toast("约束清单已复制，可直接粘贴给 Agent");
  } catch {
    toast("复制失败，请手动选择文本");
  }
});

let toastTimer = null;
function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), 2600);
}

/* ---------------- 批次：只有人明确点击才推进，文件 mtime 变化不替人做产品判断 ---------------- */
$("btn-round").addEventListener("click", async () => {
  const res = await fetch("/api/rounds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save" }),
  });
  if (!res.ok) return toast("保存批次失败");
  const data = await res.json();
  $("view-menu").open = false;
  await loadAnnotations();
  renderDrawer();
  toast(`本轮 R${data.closed} 已归档，新批注进入 R${data.activeRound}`);
});

/* ---------------- 白板：画布上的一块可写大白板（想法草稿区，不入约束） ---------------- */
async function placeBoard(event) {
  const p = toWorld(event.clientX, event.clientY);
  const created = await canvasApi("/api/canvas/notes", {
    method: "POST",
    body: JSON.stringify({ x: p.x - 210, y: p.y - 150, text: "", type: "board", doc: state.path }),
  });
  state.notes.push(created.note);
  renderNotes();
  toast("白板已放置 · 双击写入（白板是草稿区，不计入 Agent 约束）");
}

/* ---------------- 左栏：像 VSCode 一样打开本地文件夹（可视化目录选择器） ---------------- */
const fsState = { cur: "", up: null };

async function fsLoad(dir) {
  const res = await fetch(`/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ""}`);
  if (!res.ok) { toast("无法访问该目录"); return; }
  const data = await res.json();
  fsState.cur = data.cur;
  fsState.up = data.up;
  $("fs-cur").textContent = data.cur;
  $("fs-crumb").textContent = data.cur;
  $("fs-quick").innerHTML = data.quick
    .map((q) => `<button data-fs-path="${escapeHtml(q.path)}">${escapeHtml(q.name)}</button>`).join("");
  $("fs-list").innerHTML = data.dirs.length
    ? data.dirs.map((d) => `<div class="fs-item" data-fs-path="${escapeHtml(d.path)}"><span class="fs-ico">▸</span><span>${escapeHtml(d.name)}</span></div>`).join("")
    : '<div class="fs-empty">（没有子文件夹 · 可直接点「打开此文件夹」）</div>';
  $("fs-up").disabled = !data.up;
}

async function switchVault(path) {
  const res = await fetch("/api/vault", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) { toast("打开失败：目录不存在或不可访问"); return false; }
  const data = await res.json();
  $("fs-modal").hidden = true;
  state.vaultRoot = data.root;
  await resetDocView();
  await loadTree();
  toast(`已打开 ${data.root}`);
  return true;
}

$("btn-vault").addEventListener("click", async () => {
  const button = $("btn-vault");
  button.disabled = true;
  button.textContent = "正在选择…";
  try {
    const res = await fetch("/api/folder-picker", { method: "POST" });
    if (res.ok) {
      const data = await res.json();
      await switchVault(data.path);
      return;
    }
    const data = await res.json().catch(() => ({}));
    if (data.error === "cancelled") return;
    // 非 macOS 或系统选择器不可用时保留网页目录浏览作为兜底。
    $("fs-modal").hidden = false;
    await fsLoad("");
  } finally {
    button.disabled = false;
    button.textContent = "打开文件夹…";
  }
});
$("fs-close").addEventListener("click", () => { $("fs-modal").hidden = true; });
$("fs-modal").addEventListener("mousedown", (event) => {
  if (event.target === $("fs-modal")) $("fs-modal").hidden = true; // 点遮罩关闭，点卡片内部不关
});
$("fs-quick").addEventListener("click", (event) => {
  const target = event.target.closest("[data-fs-path]");
  if (target) fsLoad(target.dataset.fsPath);
});
$("fs-list").addEventListener("click", (event) => {
  const target = event.target.closest("[data-fs-path]");
  if (target) fsLoad(target.dataset.fsPath);
});
$("fs-up").addEventListener("click", () => { if (fsState.up) fsLoad(fsState.up); });
$("fs-open").addEventListener("click", async () => {
  if (!fsState.cur) return;
  await switchVault(fsState.cur);
});

/* ---------------- 侧栏「＋」新建文档：选格式 → 起名 → 创建并直接进入编辑 ---------------- */
let nfExt = ".md";
$("btn-new-file").addEventListener("click", (event) => {
  event.stopPropagation();
  const pop = $("new-file-pop");
  pop.hidden = !pop.hidden;
  if (!pop.hidden) { $("nf-name").value = ""; $("nf-name").focus(); }
});
document.querySelectorAll("#new-file-pop [data-nf-ext]").forEach((button) => {
  button.addEventListener("click", () => {
    nfExt = button.dataset.nfExt;
    document.querySelectorAll("#new-file-pop [data-nf-ext]").forEach((b) => b.classList.toggle("active", b === button));
    $("nf-name").focus();
  });
});
async function createNewFile() {
  const input = $("nf-name");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const res = await fetch("/api/create-file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, ext: nfExt }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    toast(data.error === "exists" ? `已存在 ${data.rel || "同名文件"}，换个名字` : "创建失败，请检查文件名");
    return;
  }
  $("new-file-pop").hidden = true;
  await loadTree();
  await openDoc(data.rel);
  setWorkspaceMode("edit");
  toast(`已创建 ${data.rel}，直接开始写`);
}
$("nf-create").addEventListener("click", createNewFile);
$("nf-name").addEventListener("keydown", (event) => {
  event.stopPropagation();
  if (event.key === "Enter") createNewFile();
  if (event.key === "Escape") $("new-file-pop").hidden = true;
});

/* ---------------- 外部修改感知：只重新锚定，不自动推进批次 ---------------- */
/* 防误判：先验服务端当前 vault。目录被其他标签页/CLI 切走时，同相对路径会读到别的文件，
   mtime 必然变化 —— 不验 vault 就会虚推进批次（真实事故：2 秒内连推 7 轮）。 */
async function resetDocView() {
  if (editSession) leaveEditUi(); // 目录切换守卫：不能留一个指向旧文件的悬空编辑会话
  state.path = null;
  state.annotations = [];
  $("empty").style.display = "";
  $("docpath").textContent = "未选择文档";
  $("doc").innerHTML = "";
  hideSelMenu();
}

setInterval(async () => {
  if (!state.path) return;
  try {
    const vaultRes = await fetch("/api/vault");
    if (vaultRes.ok) {
      const vault = await vaultRes.json();
      if (vault.root && state.vaultRoot && vault.root !== state.vaultRoot) {
        state.vaultRoot = vault.root;
        await resetDocView();
        await loadTree();
        toast("目录已在别处切换，请重新选择文档");
        return;
      }
    }
  } catch { /* vault 查询失败不阻塞 mtime 轮询 */ }
  const res = await fetch(`/api/doc?p=${encodeURIComponent(state.path)}`);
  if (!res.ok) return;
  const data = await res.json();
  if (data.mtime === state.mtime) return;
  state.text = data.text;
  state.mtime = data.mtime;
  toast("检测到文件已更新：批注正在重新锚定，本轮编号保持不变");
  await loadAnnotations();
}, 4000);

window.addEventListener("resize", applyTransform);
window.addEventListener("popstate", (event) => {
  const path = (event.state && event.state.doc) || new URLSearchParams(location.search).get("doc");
  if (path && path !== state.path) openDoc(path, { push: false });
});

loadTree().then(async () => {
  syncWorkspaceModeUi();
  await loadCanvas();
  const wanted = new URLSearchParams(location.search).get("doc");
  const fallback = document.querySelector("#tree .file");
  const target = wanted || (fallback && fallback.dataset.path);
  if (target) await openDoc(target, { push: false });
  if (target) history.replaceState({ doc: target }, "", `?doc=${encodeURIComponent(target)}`);
});
