const $ = (id) => document.getElementById(id);
const PAGE_W = 760;
const CARD_W = 300;
const CARD_GAP = 18;
const RAIL_X = PAGE_W + 90;

const view = { panX: 60, panY: 40, zoom: 1 };
const state = { path: null, text: "", mtime: 0, annotations: [], selected: null,
  arrows: [], notes: [], images: [], drafts: [], canvasTool: "select", arrowColor: "red", canvasSelected: null };

/* 画布元素按文档归属：无 doc 的旧元素视为全局，始终显示 */
function ownsCanvas(item) {
  return !item.doc || item.doc === state.path;
}

/* ---------------- 坐标 ---------------- */
function applyTransform() {
  $("world").style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
  $("zoom").textContent = `${Math.round(view.zoom * 100)}%`;
  const step = 26 * view.zoom;
  $("viewport").style.backgroundSize = `${step}px ${step}px`;
  $("viewport").style.backgroundPosition = `${view.panX}px ${view.panY}px`;
  drawLines();
}

function toWorld(clientX, clientY) {
  const rect = $("viewport").getBoundingClientRect();
  return { x: (clientX - rect.left - view.panX) / view.zoom, y: (clientY - rect.top - view.panY) / view.zoom };
}

function worldRect(element) {
  const rect = element.getBoundingClientRect();
  const topLeft = toWorld(rect.left, rect.top);
  return {
    x: topLeft.x,
    y: topLeft.y,
    w: rect.width / view.zoom,
    h: rect.height / view.zoom,
  };
}

function zoomAt(factor, clientX, clientY) {
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
  const rect = $("viewport").getBoundingClientRect();
  view.panX = rect.width / 2 - worldX * view.zoom;
  view.panY = rect.height / 2 - worldY * view.zoom;
  applyTransform();
}

function fit() {
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
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
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
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + length);
    const mark = document.createElement("mark");
    mark.dataset.ann = id;
    mark.className = "anchor";
    try {
      range.surroundContents(mark);
    } catch {
      const span = document.createElement("span");
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
  for (const annotation of state.annotations) {
    if (annotation.region) continue; // 区域批注不参与文本锚定
    const index = buildIndex($("doc")); // 每条重建：wrapRange 会改变 DOM 文本节点
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
  document.querySelectorAll(".anchor").forEach((node) => {
    const item = state.annotations.find((entry) => entry.id === node.dataset.ann);
    node.dataset.status = item ? item.status : "active";
  });
  return decayed;
}

/* ---------------- 卡片 ---------------- */
const LABELS = { active: "生效", addressed: "已处理", stale: "过期", deprecated: "废弃" };

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
  card.innerHTML = `
    <div class="c-head">
      <span class="c-id">${annotation.id}</span>
      <span class="c-badge">${LABELS[annotation.status] || annotation.status}</span>
      ${annotation.__drifted ? '<span class="c-flag">漂移</span>' : ""}
      ${annotation.__lost ? '<span class="c-flag">锚点失效</span>' : ""}
      ${conflicting.length ? `<span class="c-conflict" title="与 ${conflicting.join("、")} 针对同一处原文，需裁定">冲突 ${conflicting.join("/")}</span>` : ""}
      <span class="c-weight" title="权重 ${Number(annotation.weight ?? 1).toFixed(2)}">${weightDots(annotation.weight)}</span>
    </div>
    <div class="c-body">${escapeHtml(annotation.body || "")}</div>
    <div class="c-quote">${escapeHtml(annotation.quote || "（原文已变更，锚点失效）")}</div>
    <div class="c-actions">
      <button data-act="addressed">已处理</button>
      <button data-act="deprecated">废弃</button>
      <button data-act="revive">恢复生效</button>
      ${conflicting.length ? '<button data-act="supersede">以此为准</button>' : ""}
    </div>`;

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
    const mark = $("doc").querySelector(`.anchor[data-ann="${annotation.id}"]`);
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
        toast(`${annotation.id} 已替代 ${losers.join("、")}（被替代者保留为废弃状态）`);
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

/* ---------------- 牵引线 ---------------- */
function drawLines() {
  const svg = $("lines");
  svg.setAttribute("width", "12000");
  svg.setAttribute("height", "12000");
  svg.innerHTML = "";
  const pageRect = worldRect($("page"));
  for (const annotation of state.annotations) {
    const mark = $("doc").querySelector(`.anchor[data-ann="${annotation.id}"]`)
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
    box.innerHTML = `<span>${annotation.id}</span>`;
    layer.appendChild(box);
  }
}

function bindRegionStage(stage, imagePath) {
  stage.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const bounds = stage.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const draft = document.createElement("div");
    draft.className = "region-draft";
    stage.appendChild(draft);
    const move = (moveEvent) => {
      const x1 = Math.min(startX, moveEvent.clientX) - bounds.left;
      const y1 = Math.min(startY, moveEvent.clientY) - bounds.top;
      const x2 = Math.max(startX, moveEvent.clientX) - bounds.left;
      const y2 = Math.max(startY, moveEvent.clientY) - bounds.top;
      draft.style.left = `${x1}px`;
      draft.style.top = `${y1}px`;
      draft.style.width = `${x2 - x1}px`;
      draft.style.height = `${y2 - y1}px`;
    };
    const up = (upEvent) => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      draft.remove();
      const x = Math.min(startX, upEvent.clientX) - bounds.left;
      const y = Math.min(startY, upEvent.clientY) - bounds.top;
      const w = Math.abs(upEvent.clientX - startX);
      const h = Math.abs(upEvent.clientY - startY);
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
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

function bindImageSelection() {
  const stage = $("image-stage");
  if (stage) bindRegionStage(stage, null);
  for (const inline of $("doc").querySelectorAll(".ii-stage")) {
    bindRegionStage(inline, inline.closest("figure.inline-image").dataset.image);
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
    const textWidth = context.measureText(annotation.id).width;
    const pad = font * 0.4;
    context.fillStyle = color;
    context.fillRect(x, y - font - pad * 2, textWidth + pad * 2, font + pad * 2);
    context.fillStyle = "#fff";
    context.fillText(annotation.id, x + pad, y - pad * 1.4);
  }

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  const base = (state.path.split("/").pop() || "image").replace(/\.[^.]+$/, "");
  const name = `${base}-annotated-${Date.now()}.png`;
  const response = await fetch(`/api/asset?name=${encodeURIComponent(name)}`, { method: "POST", body: blob });
  const saved = await response.json();

  if (!openDrawer) return { saved, listed };

  const lines = [
    "[@Marginalia] 按标注修改图片",
    "",
    `源图：${state.path}`,
    `标注截图：${saved.rel}`,
    "",
    "生效标注：",
    ...listed.map((item) => `- [${item.id}] ${item.body}（区域 x=${item.region.x.toFixed(2)} y=${item.region.y.toFixed(2)} w=${item.region.w.toFixed(2)} h=${item.region.h.toFixed(2)}）`),
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
  // 手绘箭头标签与便签是人在画布上写的活约束，一并纳入修改指令
  const canvasArrows = state.arrows.filter((item) => ownsCanvas(item) && (item.label || "").trim());
  const canvasNotes = state.notes.filter((item) => ownsCanvas(item) && (item.text || "").trim());
  const lines = [
    `[@Marginalia] 按标注修改 ${state.path}`,
    "",
    "请根据这份文档的人类批注修改它：",
    `- 目标文件：${state.path}`,
    `- 生效批注 ${active.length} 条，每条都是必须尊重的约束；标记冲突的条目未经裁定前先询问用户`,
    ...(screenshotRel ? [`- 图片标注截图：${screenshotRel}（区域框与编号已烧录进图，作为权威视觉参考）`] : []),
    state.mode === "image"
      ? "- 产出新版本图片放在原图旁边，不要覆盖原图"
      : "- 直接在文件上修改；文本批注对应的原文位置可用 quote 上下文定位",
    "- 完成后逐条核对：在回复里列出 A-#### → 处理结果",
    "- 不要修改或删除 .marginalia/ 下的任何批注记录",
    "",
    "生效批注：",
    ...active.map((item) => {
      const where = item.region
        ? `区域 x=${item.region.x.toFixed(2)} y=${item.region.y.toFixed(2)} w=${item.region.w.toFixed(2)} h=${item.region.h.toFixed(2)}`
        : `「${(item.quote || "").slice(0, 60)}」`;
      const conflict = (item.conflicts_with || []).length ? ` ⚠与${item.conflicts_with.join("/")}冲突` : "";
      return `- [${item.id}] w=${Number(item.weight ?? 1).toFixed(2)} ${where} → ${item.body}${conflict}`;
    }),
    ...(canvasArrows.length ? [
      "",
      "画布手绘箭头（人的视觉指令）：",
      ...canvasArrows.map((item) => `- [${item.id}]「${item.label.trim()}」`),
    ] : []),
    ...(canvasNotes.length ? [
      "",
      "画布便签：",
      ...canvasNotes.map((item) => `- [${item.id}] ${item.text.trim()}`),
    ] : []),
  ];
  const total = active.length + canvasArrows.length + canvasNotes.length;
  const prompt = lines.join("\n");
  $("drawer-body").innerHTML = `
    <div class="d-item">
      <div class="d-item-head"><span class="c-id">修改指令已组装</span></div>
      <div class="d-item-body">${total} 条约束（批注 ${active.length} · 箭头 ${canvasArrows.length} · 便签 ${canvasNotes.length}）${screenshotRel ? " · 标注图已导出" : ""}。复制后发给任何 Agent 即可执行。</div>
    </div>
    <textarea id="export-prompt" class="d-export">${escapeHtml(prompt)}</textarea>
    <button id="export-copy" class="chip">复制修改指令</button>`;
  $("drawer").hidden = false;
  $("export-copy").addEventListener("click", async () => {
    await navigator.clipboard.writeText(prompt);
    toast("修改指令已复制，粘贴给 Agent 即可");
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
  for (const note of state.notes) {
    if (!ownsCanvas(note)) continue;
    host.appendChild(noteElement(note));
  }
}

function noteElement(note) {
  const node = document.createElement("div");
  node.className = "note";
  node.dataset.id = note.id;
  node.contentEditable = "false";
  node.dataset.placeholder = "写点想法…";
  node.textContent = note.text || "";
  node.style.left = `${note.x}px`;
  node.style.top = `${note.y}px`;
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
function cardDrag(node, item, patchFields) {
  node.addEventListener("pointerdown", (event) => {
    if (event.target.closest("button, iframe, a")) return;
    event.stopPropagation();
    selectCanvas({ type: item.__type, id: item.id });
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = item.x;
    const originY = item.y;
    node.classList.add("dragging");
    const move = (moveEvent) => {
      item.x = originX + (moveEvent.clientX - startX) / view.zoom;
      item.y = originY + (moveEvent.clientY - startY) / view.zoom;
      node.style.left = `${item.x}px`;
      node.style.top = `${item.y}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      node.classList.remove("dragging");
      canvasPatch("/api/canvas/" + item.__type, { id: item.id, x: item.x, y: item.y });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
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
    node.innerHTML = `<img src="${url}" alt="" style="width:100%"><div class="ic-tag">${escapeHtml(name)}</div>`;
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
  if (event.key === "v" || event.key === "V") setTool("select");
  if (event.key === "a" || event.key === "A") setTool("arrow");
  if (event.key === "n" || event.key === "N") setTool("note");
  if (event.key === "i" || event.key === "I") $("file-input").click();
  if (event.key === "Escape") { selectCanvas(null); setTool("select"); }
  if (event.key === "?" || (event.shiftKey && event.key === "/")) {
    const help = $("shortcut-help");
    help.hidden = !help.hidden;
  }
  if ((event.key === "Delete" || event.key === "Backspace") && state.canvasSelected) {
    const sel = state.canvasSelected;
    const endpoints = { arrow: ["arrows", "/api/canvas/arrows", "箭头"], note: ["notes", "/api/canvas/notes", "便签"], image: ["images", "/api/canvas/images", "图卡"], draft: ["drafts", "/api/canvas/drafts", "草稿卡"] };
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
    body: JSON.stringify({ path: state.path, selected: selection }),
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
  applyTransform();
  toast("已整理布局");
}

function estimateCardHeight(annotation) {
  const lines = Math.ceil((annotation.body || "").length / 26);
  return 96 + lines * 22;
}

function anchorY(annotation) {
  const mark = $("doc").querySelector(`.anchor[data-ann="${annotation.id}"]`)
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
  const host = $("doc");
  if (state.mode === "pdf") {
    if (!(await waitForPdfRenderer())) {
      host.innerHTML = '<p style="color:#c99537">PDF 渲染器未能加载（离线？）。可用系统预览打开。</p>';
      return;
    }
    try {
      const result = await window.renderPdfToContainer(host, `/api/raw?p=${encodeURIComponent(state.path)}`);
      state.text = result.text;
      $("docpath").textContent = `${state.path} · ${result.pages} 页`;
    } catch (err) {
      host.innerHTML = `<p style="color:#e0604f">PDF 渲染失败：${String(err && err.message || err)}</p>`;
    }
    return;
  }
  if (state.mode === "image") {
    host.innerHTML = `
      <div class="image-stage" id="image-stage">
        <img id="image-node" src="/api/raw?p=${encodeURIComponent(state.path)}" alt="" />
        <div class="region-layer" id="region-layer"></div>
      </div>`;
    return;
  }
  host.innerHTML = /\.html?$/i.test(state.path || "")
    ? state.text.replace(/<script[\s\S]*?<\/script>/gi, "") // 本地只读渲染，剥离脚本防注入
    : renderMarkdown(state.text);
}

async function loadAnnotations() {
  if (!state.path) return;
  const res = await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`);
  const data = await res.json();
  state.annotations = data.annotations || [];
  await renderDocument();
  const decayed = state.mode === "image" ? 0 : await anchorAll();
  renderRegions();
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
  state.path = path;
  state.mode = kindOf(path);
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
  $("empty").style.display = "none";
  $("btn-export").hidden = state.mode !== "image";
  document.querySelectorAll("#tree .file").forEach((node) => node.classList.toggle("current", node.dataset.path === path));
  await loadAnnotations();
  bindImageSelection();
  initialView();
}

/* 首屏视图：阅读导向 —— 页面 + 一列批注卡同时入镜，顶部对齐；纵向把画布元素也纳入视野 */
function initialView() {
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
  $("vault").textContent = data.root;
  const dot = { text: "#6b6864", pdf: "#c99537", image: "#6fa055" };
  const render = (nodes, depth) => nodes.map((node) => node.type === "dir"
    ? `<div class="dir" style="padding-left:${20 + depth * 12}px">${escapeHtml(node.name)}</div>${render(node.children || [], depth + 1)}`
    : `<div class="file" data-path="${escapeHtml(node.path)}" style="padding-left:${20 + depth * 12}px"><i style="background:${dot[node.kind] || dot.text}"></i>${escapeHtml(node.name)}</div>`).join("");
  $("tree").innerHTML = render(data.tree, 0);
  $("tree").querySelectorAll(".file").forEach((node) => {
    node.addEventListener("click", () => openDoc(node.dataset.path));
  });
}

/* ---------------- 选区批注 ---------------- */
let pending = null;

$("page").addEventListener("mouseup", (event) => {
  const selection = window.getSelection();
  const text = String(selection).trim();
  if (!text || !$("doc").contains(selection.anchorNode)) return;
  const range = selection.getRangeAt(0);
  const container = $("doc");
  const before = document.createRange();
  before.setStart(container, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.setStart(range.endContainer, range.endOffset);
  after.setEnd(container, container.childNodes.length);
  pending = {
    quote: text,
    prefix: String(before).slice(-40),
    suffix: String(after).slice(0, 40),
    worldY: worldRect(range).y,
  };
  const rect = range.getBoundingClientRect();
  const composer = $("composer");
  composer.hidden = false;
  composer.style.top = `${Math.min(rect.bottom + 10, window.innerHeight - 220)}px`;
  composer.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
  $("composer-quote").textContent = `“${text.slice(0, 90)}”`;
  $("composer-input").focus();
  event.stopPropagation();
});

$("composer-cancel").addEventListener("click", closeComposer);

function closeComposer() {
  $("composer").hidden = true;
  $("composer-input").value = "";
  pending = null;
  window.getSelection().removeAllRanges();
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

/* ---------------- 画布交互 ---------------- */
$("viewport").addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  if (event.target.closest(".card") || event.target.closest("#page") || event.target.closest("#composer") || event.target.closest(".note") || event.target.closest(".arrow-g")) return;
  if (state.canvasTool === "arrow") { startArrowDraft(event); return; }
  if (state.canvasTool === "note") { placeNote(event); return; }
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
  $("btn-theme").textContent = document.body.classList.contains("paper-dark") ? "暗色纸" : "纸张";
});
$("btn-focus").addEventListener("click", (event) => {
  const on = event.currentTarget.dataset.on === "1";
  event.currentTarget.dataset.on = on ? "0" : "1";
  document.body.classList.toggle("focus-active", !on);
});
$("btn-lines").addEventListener("click", (event) => {
  const on = event.currentTarget.dataset.on === "1";
  event.currentTarget.dataset.on = on ? "0" : "1";
  document.body.classList.toggle("lines-quiet", !on);
  drawLines();
});
$("rail-toggle").addEventListener("click", () => {
  document.body.classList.toggle("rail-hidden");
  setTimeout(applyTransform, 240);
});

/* ---------------- 约束清单抽屉 ---------------- */
function constraintsText() {
  const active = state.annotations
    .filter((item) => item.status === "active")
    .sort((a, b) => b.weight - a.weight);
  // 手绘箭头标签与便签同样是人类意图，纳入约束清单
  const canvasArrows = state.arrows.filter((item) => ownsCanvas(item) && (item.label || "").trim());
  const canvasNotes = state.notes.filter((item) => ownsCanvas(item) && (item.text || "").trim());
  const total = active.length + canvasArrows.length + canvasNotes.length;
  const lines = [
    `# ${state.path} · 修改前必读的人类约束（${total} 条）`,
    "",
    ...active.flatMap((item) => [
      `- [${item.id}] w=${Number(item.weight ?? 1).toFixed(2)} 「${item.quote.slice(0, 60)}」`,
      `  ${item.body}`,
      ...(item.conflicts_with || []).length ? [`  ⚠ 与 ${item.conflicts_with.join("/")} 冲突，未经裁定前先询问用户`] : [],
    ]),
    ...canvasArrows.map((item) => [`- [${item.id}·箭头]「${item.label.trim()}」`, "  （人在画布上手写的视觉指令）"]).flat(),
    ...canvasNotes.map((item) => [`- [${item.id}·便签] ${item.text.trim()}`]).flat(),
  ];
  return lines.join("\n");
}

function renderDrawer() {
  const active = state.annotations.filter((item) => item.status === "active");
  $("drawer-body").innerHTML = active.length ? active
    .slice()
    .sort((a, b) => b.weight - a.weight)
    .map((item) => `
      <div class="d-item">
        <div class="d-item-head"><span class="c-id">${item.id}</span><span class="c-weight">${weightDots(item.weight)}</span></div>
        <div class="d-item-body">${escapeHtml(item.body)}</div>
        <div class="d-item-quote">「${escapeHtml(item.quote.slice(0, 50))}」</div>
      </div>`)
    .join("") : '<div class="d-empty">当前没有生效批注</div>';
}

$("btn-export").addEventListener("click", () => exportAnnotatedImage());
$("btn-edit-ask").addEventListener("click", askEditWithAnnotations);
$("btn-drawer").addEventListener("click", () => {
  renderDrawer();
  $("drawer").hidden = !$("drawer").hidden;
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

/* ---------------- 外部修改感知 ---------------- */
setInterval(async () => {
  if (!state.path) return;
  const res = await fetch(`/api/doc?p=${encodeURIComponent(state.path)}`);
  if (!res.ok) return;
  const data = await res.json();
  if (data.mtime === state.mtime) return;
  state.text = data.text;
  state.mtime = data.mtime;
  toast("文档被外部修改，批注正在重新锚定");
  await loadAnnotations();
}, 4000);

window.addEventListener("resize", applyTransform);
window.addEventListener("popstate", (event) => {
  const path = (event.state && event.state.doc) || new URLSearchParams(location.search).get("doc");
  if (path && path !== state.path) openDoc(path, { push: false });
});

loadTree().then(async () => {
  await loadCanvas();
  const wanted = new URLSearchParams(location.search).get("doc");
  const fallback = document.querySelector("#tree .file");
  const target = wanted || (fallback && fallback.dataset.path);
  if (target) await openDoc(target, { push: false });
  if (target) history.replaceState({ doc: target }, "", `?doc=${encodeURIComponent(target)}`);
});
