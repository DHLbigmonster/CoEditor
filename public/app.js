const $ = (id) => document.getElementById(id);
const PAGE_W = 760;
const CARD_W = 300;
const CARD_GAP = 18;
const RAIL_X = PAGE_W + 90;

const view = { panX: 60, panY: 40, zoom: 1 };
const state = { path: null, text: "", mtime: 0, annotations: [], selected: null,
  arrows: [], notes: [], images: [], drafts: [], canvasTool: "select", arrowColor: "red", canvasSelected: null,
  vaultRoot: "", workspaceMode: "read" };

/* 文档会话身份：每次 openDoc 递增。所有异步写入全局状态的地方都必须核对自己
   拿到的 epoch——A 文档的迟到响应不得写进 B 文档的正文、批注或版本列表。 */
let docEpoch = 0;

/* 保存状态枚举（徽标的唯一真相源）：clean/dirty/saving/error/conflict。
   文本驱动的旧 syncStatus 桥接到这里，新代码直接调 setSaveState。 */
const SAVE_LABELS = { clean: "已保存到本地", dirty: "有未保存更改 · ⌘S", saving: "正在保存…", error: "未保存 · 请重试", conflict: "保存冲突 · 草稿保留" };
function setSaveState(stateName) {
  const badge = $("save-badge");
  if (!badge) return;
  badge.dataset.state = stateName === "dirty" ? "saving" : stateName;
  badge.querySelector("i").textContent = stateName === "error" ? "×" : stateName === "clean" ? "✓" : "•";
  badge.childNodes[badge.childNodes.length - 1].textContent = " " + (SAVE_LABELS[stateName] || stateName);
}
function syncStatus(text, bad = false) {
 const el = $('sync-status'); if (el) { el.textContent = text; el.dataset.error = String(bad); }
 // 顶栏常驻保存徽标：本地优先的产品承诺要一直可见，而不是藏在侧栏角落
 if (text === "正在保存…") setSaveState("saving");
 else if (text === "已保存到本地") setSaveState("clean");
 else if (/冲突/.test(text)) setSaveState("conflict");
 else if (bad) setSaveState("error");
 else if (/未保存/.test(text)) setSaveState("dirty");
}
async function checkedFetch(url, options) {
 const writing = options && options.method && options.method !== 'GET';
 if (writing) syncStatus('正在保存…');
 try {
  const response = await fetch(url, options);
  if (!response.ok) { const data = await response.clone().json().catch(() => ({})); throw new Error(data.error || 'HTTP ' + response.status); }
  if (writing) syncStatus('已保存到本地'); return response;
 } catch (error) { syncStatus('未保存 · 请重试', true); throw error; }
}
window.addEventListener('unhandledrejection', event => { syncStatus('操作未完成 · 请重试', true); toast('操作未完成：' + String(event.reason?.message || event.reason)); });
function hasDraft() { return editSession && editSession.cm.getValue() !== editSession.originalText; }
function canLeaveEditor() { return !hasDraft() || window.confirm('当前文字还没有保存。确定放弃这些修改吗？'); }
window.addEventListener('beforeunload', event => { if (hasDraft()) { event.preventDefault(); event.returnValue = ''; } });
/* U03 统一视图模型：待处理/保留/历史三组的唯一定义（顶部计数、侧栏计数、列表筛选共用）。
   保留（highlight）的意图独立于锚点与轮次状态：只有用户取消（deprecated）才离开保留组；
   锚点丢失 = 保留组内「待定位」，要求仍有效——不得归入待处理，也不得谎称已验证。
   普通批注 stale = 需要人工重看，归入待处理。 */
function feedbackGroup(item) {
  if (item.kind === "highlight") return item.status === "deprecated" ? "history" : "retained";
  if (item.status === "active" || item.status === "stale") return "pending";
  return "history";
}
let railTab = 'feedback'; // 右栏两个视图：大纲（标题导航）/ 反馈（批注分类）

/* 大纲：从渲染结果提取 h1-h3（md 在 #doc，HTML 在预览 iframe 里），点击滚到对应位置 */
function extractOutline() {
  const collect = (root) => {
    if (!root) return [];
    const items = [];
    root.querySelectorAll("h1, h2, h3").forEach((el) => {
      const text = (el.textContent || "").trim().slice(0, 60);
      if (!text) return;
      el.dataset.outlineIdx = String(items.length);
      items.push({ level: Number(el.tagName[1]), text, idx: items.length });
    });
    return items;
  };
  let outline = [];
  try {
    const frame = $("html-frame");
    if (frame && frame.contentDocument && frame.contentDocument.body) outline = collect(frame.contentDocument);
  } catch { /* 跨文档不可达时忽略 */ }
  if (!outline.length) { try { outline = collect($("doc")); } catch { /* 同上 */ } }
  state.outline = outline;
}

function goToOutline(idx) {
  let el = null; let inFrame = false;
  try {
    const frame = $("html-frame");
    if (frame && frame.contentDocument) { el = frame.contentDocument.querySelector(`[data-outline-idx="${idx}"]`); inFrame = true; }
  } catch { /* 忽略 */ }
  if (!el) el = $("doc").querySelector(`[data-outline-idx="${idx}"]`);
  if (!el) return;
  document.querySelectorAll('.outline-item').forEach(node => node.classList.toggle('active', Number(node.dataset.outlineGo) === idx));
  if (!inFrame) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return; }
  // iframe 自适应高度、无内部滚动：scrollIntoView 会沿祖先链滚到外层容器（与 md 路径同一行为）
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}
let feedbackFilter = 'pending';
/* 版本对照状态（feedbackTabs 与渲染共用；选中记 id 不记序号——序号会随新增版本移位） */
let versionState = { list: [], activeId: null, diff: null, diffChanged: null, loading: false, view: 'side', sideMode: 'render', report: null, rendered: null };

/* 排版并排：md/txt 用与阅读模式同一套 renderMarkdown，HTML 用原始保真源码，
   各自装进禁脚本的 iframe（sandbox=""）——展示排版，不执行内容。 */
const RENDERABLE_TEXT = /\.(md|markdown|txt|html?|json|csv)$/i;
const PAPER_CSS = `body{margin:0;padding:26px 28px;font:15px/1.9 -apple-system,BlinkMacSystemFont,"PingFang SC","Songti SC",serif;color:#0d0d0d;background:#fff;overflow-wrap:break-word}
h1{font-size:23px;line-height:1.4}h2{font-size:18px;line-height:1.5}h3{font-size:15.5px}h1,h2,h3{margin:1.2em 0 .5em}
p{margin:.6em 0}ul,ol{padding-left:1.4em}blockquote{margin:1em 0;padding:2px 14px;border-left:3px solid #e4e4e4;color:#5d5d5d}
pre{background:#f6f6f6;padding:12px;border-radius:8px;overflow:auto}code{font-family:"SF Mono",Menlo,monospace;font-size:12.5px}
img{max-width:100%}hr{border:0;border-top:1px solid #e4e4e4}a{color:#0d0d0d}`;
const wrapRendered = (inner, isRawHtml) => isRawHtml
  ? inner
  : `<!doctype html><html><head><meta charset="utf-8"><style>${PAPER_CSS}</style></head><body>${inner}</body></html>`;
const renderSourceDoc = (text, path) => {
  const isHtml = /\.html?$/i.test(path || "");
  const isPlain = /\.(json|csv|txt)$/i.test(path || "");
  const body = isHtml ? text.replace(/<script[\s\S]*?<\/script>/gi, "") : isPlain ? `<pre>${escapeHtml(text)}</pre>` : renderMarkdown(text);
  return wrapRendered(body, isHtml);
};

async function ensureRenderedDiff(active) {
  const key = active && active.id;
  if (!key) return;
  if (versionState.rendered && versionState.rendered.key === key) return;
  versionState.rendered = { key, left: null, right: null };
  try {
    // 有快照读快照（登记那一刻的字节）：活动文件后来怎么改都偷换不了历史对照
    const snap = active.snapshot || null;
    const [orig, next] = await Promise.all([
      snap && snap.source ? (await fetch(`/api/raw?p=${encodeURIComponent(snap.source)}`)).text()
        : (await fetch(`/api/doc?p=${encodeURIComponent(state.path)}`)).json().then(d => d.text || ""),
      snap && snap.next ? (await fetch(`/api/raw?p=${encodeURIComponent(snap.next)}`)).text()
        : (await fetch(`/api/doc?p=${encodeURIComponent(active.file)}`)).json().then(d => d.text || ""),
    ]);
    versionState.rendered.left = renderSourceDoc(orig, state.path);
    versionState.rendered.right = renderSourceDoc(next, active.file);
  } catch { versionState.rendered = { key, left: null, right: null }; }
  const shell = document.querySelector("#cards .version-panel, #drawer-body .version-panel");
  if (shell) paintVersions(shell);
}

/* S1' 分组收敛：主视图只保留 待修改/已修改 两组；保留/历史/版本对照进「更多」下拉 */
function feedbackTabs() {
 const main = [['pending', '待修改'], ['addressed', '已修改']];
 const groupCount = key => state.annotations.filter(x => feedbackGroup(x) === key).length;
 let html = '<div class="feedback-tabs" role="tablist" aria-label="反馈分类">';
 html += main.map(([key, name]) => '<button role="tab" aria-selected="' + (feedbackFilter === key) + '" data-feedback="' + key + '">' + name + ' <b>' + groupCount(key) + '</b></button>').join('');
 const histCount = groupCount('history');
 html += '<details class="tabs-more"><summary title="保留要求与版本对照">⋯</summary><div>'
      + '<button data-feedback="history">更早的意见 <b>' + histCount + '</b></button>'
      + '<button data-feedback="retained">保留 <b>' + groupCount('retained') + '</b></button>'
      + '<button data-feedback="versions">版本对照 <b>' + versionState.list.length + '</b></button>'
      + '</div></details>';
 html += '</div>';
 return html;
}
document.addEventListener('click', event => { const button = event.target.closest('[data-feedback]'); if (!button) return; feedbackFilter = button.dataset.feedback; renderCards(); renderDrawer(); drawLines(); });
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

let pdfZoomApplied = 1;

/** 记住光标位置对应的「页码 + 页内归一化点 + 屏幕偏移」，供重渲染后还原 */
function captureZoomAnchor(clientX, clientY) {
  const viewport = $("viewport");
  const vr = viewport.getBoundingClientRect();
  const under = document.elementFromPoint(clientX, clientY);
  const page = under && under.closest ? under.closest(".pdf-page") : null;
  if (!page) return null;
  const pr = page.getBoundingClientRect();
  if (!pr.width || !pr.height) return null;
  return {
    page: Number(page.dataset.page),
    fx: (clientX - pr.left) / pr.width,
    fy: (clientY - pr.top) / pr.height,
    dx: clientX - vr.left,
    dy: clientY - vr.top,
  };
}

/** 把锚点恢复到同一屏幕位置（渲染完成后调用，只动滚动，不动倍率） */
function restoreZoomAnchor(anchor) {
  if (!anchor) return;
  const viewport = $("viewport");
  const page = $("doc").querySelector(`.pdf-page[data-page="${anchor.page}"]`);
  if (!page) return;
  const vr = viewport.getBoundingClientRect();
  const pr = page.getBoundingClientRect();
  if (!pr.width || !pr.height) return;
  const pointX = pr.left + anchor.fx * pr.width;
  const pointY = pr.top + anchor.fy * pr.height;
  viewport.scrollLeft += pointX - (vr.left + anchor.dx);
  viewport.scrollTop += pointY - (vr.top + anchor.dy);
}

/** 缩放：同步改尺寸，不重建 DOM。
    位图按新分辨率重画由 pdf-layer 自己防抖（离屏画好再贴回，旧位图全程可见）。
    因为文本层没有被重建，批注 <mark> 跟着百分比一起缩放，**不需要重新锚定**。 */
function applyPdfScale() {
  if (state.mode !== "pdf" || state.workspaceMode !== "read") return;
  if (typeof window.setPdfZoom !== "function") return;
  try {
    window.setPdfZoom($("doc"), view.zoom);
    pdfZoomApplied = view.zoom;
    renderRegions();
    drawLines();
  } catch { /* 渲染失败保持现状，下次缩放再试 */ }
}

/** 容器宽度 / DPR 变了：fitScale 必须重算，这条只能完整重建（少见，重建后重新锚定） */
let pdfRebuildTimer = null;
function schedulePdfRebuild() {
  if (state.mode !== "pdf" || state.workspaceMode !== "read") return;
  clearTimeout(pdfRebuildTimer);
  pdfRebuildTimer = setTimeout(async () => {
    if (typeof window.rerenderPdfWithCols !== "function") return;
    const epoch = docEpoch;
    try {
      await window.rerenderPdfWithCols($("doc"), `/api/raw?p=${encodeURIComponent(state.path)}`, state.pdfCols || 1);
      if (epoch !== docEpoch) return;
      pdfZoomApplied = view.zoom;
      await anchorAll();
      renderRegions();
      drawLines();
    } catch { /* 失败保持现状 */ }
  }, 260);
}

function applyTransform() {
  if (!isCanvasMode()) {
    const world = $("world");
    world.style.transform = "none";
    if (state.mode === "pdf") {
      // PDF：CSS zoom 只会让画布在 flex 里被压缩（永远「没有变化」的假放大），
      // 缩放交给 pdf-layer 真正重渲染
      $("page").style.zoom = "";
      applyPdfScale();
    } else {
      $("page").style.zoom = String(view.zoom); // 流式文档：放大 = 加大字号，自适应可用宽
    }
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
    // 与浏览器/PDF 阅读器一致：放大只作用于文档内容，范围放开到 50%–300%
    const next = Math.min(3, Math.max(0.5, old * factor));
    if (next === old) return;
    view.zoom = next;
    if (state.mode === "pdf" && state.workspaceMode === "read") {
      // 先在旧几何下记锚点 → 同步改尺寸 → 再按新几何把同一点拨回同一屏幕位置。
      // 现在尺寸是同步变的，所以整个手势期间手指下的那个点都钉得住，不会等 3 秒才归位。
      const anchor = captureZoomAnchor(clientX, clientY);
      applyTransform();
      restoreZoomAnchor(anchor);
      return;
    }
    const ratio = next / old;
    const vr = viewport.getBoundingClientRect();
    viewport.scrollLeft = (viewport.scrollLeft + clientX - vr.left) * ratio - (clientX - vr.left);
    viewport.scrollTop = (viewport.scrollTop + clientY - vr.top) * ratio - (clientY - vr.top);
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

/* 「适合宽度」：纸面缩放因子回到 1——纸面宽度由 updatePaperWidth 维护为
   min(820, 可用宽)，天然等于可用宽。PDF 的 fit 基准由 pdf-layer 按容器宽计算。 */
function fitReadWidth() {
  updatePaperWidth();
  view.zoom = 1;
  applyTransform();
  $("viewport").scrollTo({ left: 0, behavior: "smooth" });
}

/* 固定版心纸面（md/txt/docx/json/csv = 理想 820px）：
   100% 时自动适配可用宽（小窗不横滚），放大后按比例超出产生内部滚动。
   HTML 是网页，例外：保持自适应（CSS :has 分支）。 */
function updatePaperWidth() {
  if (isCanvasMode()) return;
  if (state.mode === "pdf" || document.querySelector("#page .html-view")) return; // PDF/html 各有自适应
  const viewport = $("viewport");
  const cardsVisible = !document.body.classList.contains("cards-hidden") && window.innerWidth > 1180;
  const avail = Math.max(360, viewport.clientWidth - 58); // 文档内边距（反馈栏是布局同级列，viewport 已被压缩）
  document.documentElement.style.setProperty("--paper-w", `${Math.min(820, avail)}px`);
}

function fit() {
  if (!isCanvasMode()) {
    fitReadWidth();
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

/* ---------------- 批注卡 ↔ 正文 悬停互链 ----------------
   四种元素都带 id：抽屉条目 .d-item[data-id]、画布卡 .card[data-id]、
   正文锚点 .anchor[data-ann]、区域框 .region[data-ann]。悬停任一侧点亮其余侧。
   正文锚点每次渲染都重建（wrapRange），所以正文侧必须事件委托，逐元素绑定会漏。 */
let peekActive = null;
const PEEK_SEL = ".anchor[data-ann], .region[data-ann]";

function peekNodes(id) {
  const root = annotationRoot();
  const inDoc = root ? root.querySelectorAll(`.anchor[data-ann="${id}"], .region[data-ann="${id}"]`) : [];
  const cards = document.querySelectorAll(`.d-item[data-id="${id}"], .card[data-id="${id}"]`);
  return [...inDoc, ...cards];
}

function clearPeek() {
  if (!peekActive) return;
  for (const node of peekNodes(peekActive)) node.classList.remove("coeditor-peek");
  peekActive = null;
}

function applyPeek(id) {
  if (!id || peekActive === id) return;
  clearPeek();
  peekActive = id;
  for (const node of peekNodes(id)) node.classList.add("coeditor-peek");
}

// root 可以是 #doc（元素）或 iframe 的 contentDocument（文档）：__coeditorPeek 标记两者都吃
function bindPeek(root) {
  if (!root || root.__coeditorPeek) return;
  root.__coeditorPeek = true;
  root.addEventListener("mouseover", (event) => {
    const el = event.target && event.target.closest ? event.target.closest(PEEK_SEL) : null;
    if (el) applyPeek(el.dataset.ann);
    else clearPeek();
  });
  root.addEventListener("mouseout", (event) => {
    const next = event.relatedTarget;
    const nextEl = next && next.closest ? next.closest(PEEK_SEL) : null;
    if (nextEl) applyPeek(nextEl.dataset.ann);
    else clearPeek();
  });
}

function bindPeekDrawer() {
  const body = $("drawer-body");
  if (!body || body.__coeditorPeek) return;
  body.__coeditorPeek = true;
  body.addEventListener("mouseover", (event) => {
    const item = event.target.closest(".d-item[data-id]");
    if (item) applyPeek(item.dataset.id);
    else clearPeek();
  });
  body.addEventListener("mouseleave", clearPeek);
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

/* ---------------- 锚点 ----------------
 * B01 根因（2026-09-11 实测）：保存的 quote 源自 Selection.toString()，跨行时带 "\n"；
 * 而 PDF 文字层的文本节点拼接出来**没有分隔符**（"…附录 AWorking draft…"）。
 * 两者直接 indexOf 必然 -1 → locate 返回 null → 一个 mark 都不画 → "原文看不到批注"。
 * 所以这里严格分两套字符串：
 *   text —— 原文，只用于取字形/偏移，不参与匹配
 *   norm —— 匹配用规范文本（去空白 + NFKC），normToRaw 保存回原偏移的映射
 * 匹配在 norm 空间做，落点映射回 raw 空间，wrapRange 才能拿到真实的 DOM 位置。
 */
function normChar(ch) {
  if (/\s/.test(ch)) return ""; // 换行/全角空格/不换行空格一律不可见于匹配
  const k = ch.normalize("NFKC"); // 全角→半角、连字 ﬁ→fi（多字符时映射会重复指向同一 raw 位置）
  return k === ch ? ch : k;
}

function normalizeForMatch(value) {
  let out = "";
  for (const ch of String(value || "")) out += normChar(ch);
  return out;
}

/** 页/文档内容指纹：内容没变才能用精确偏移，变了必须重新定位 */
function textFingerprint(value) {
  const s = String(value || "");
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

function buildIndex(root) {
  const owner = root.ownerDocument || document;
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const raw = []; // raw 下标 → { node, offset }
  const normToRaw = []; // norm 下标 → raw 下标
  let text = "";
  let norm = "";
  let node;
  while ((node = walker.nextNode())) {
    const value = node.nodeValue;
    for (let i = 0; i < value.length; i += 1) {
      const rawIndex = text.length;
      const ch = value[i];
      text += ch;
      raw.push({ node, offset: i });
      const k = normChar(ch);
      for (let j = 0; j < k.length; j += 1) { norm += k[j]; normToRaw.push(rawIndex); }
    }
  }
  return { text, norm, raw, normToRaw };
}

function locate(index, annotation) {
  // 1) 内容未变 → 用保存的精确偏移，不做任何猜测
  const fp = textFingerprint(index.text);
  if (Number.isFinite(annotation.textOffset) && annotation.pageFp && annotation.pageFp === fp) {
    const start = annotation.textOffset;
    const end = Number.isFinite(annotation.textLen) ? start + annotation.textLen : start + normalizeForMatch(annotation.quote).length;
    if (start >= 0 && end <= index.raw.length && end > start) return { start, end, exact: true, drifted: false };
  }
  // 2) 否则按规范化文本搜索（跨行/空白/全角/连字差异都在这里被吸收）
  const quote = normalizeForMatch(annotation.quote);
  if (!quote) return null;
  const candidates = [quote];
  if (quote.length > 24) candidates.push(quote.slice(0, 24));
  for (const candidate of candidates) {
    const hits = [];
    let at = index.norm.indexOf(candidate);
    while (at >= 0) { hits.push(at); at = index.norm.indexOf(candidate, at + 1); }
    if (!hits.length) continue;
    // 多处命中时用 prefix/suffix 上下文消歧，避免重复句钉到第一处
    const prefix = normalizeForMatch(annotation.prefix);
    const suffix = normalizeForMatch(annotation.suffix);
    let best = hits[0];
    let bestScore = -1;
    for (const start of hits) {
      let score = 0;
      if (prefix && index.norm.slice(Math.max(0, start - prefix.length), start) === prefix) score += 2;
      if (suffix && index.norm.slice(start + candidate.length, start + candidate.length + suffix.length) === suffix) score += 2;
      if (score > bestScore) { bestScore = score; best = start; }
      if (score === 4) break;
    }
    const normEnd = best + candidate.length;
    return {
      start: index.normToRaw[best],
      end: (index.normToRaw[normEnd - 1] ?? index.raw.length - 1) + 1,
      drifted: candidate !== quote,
    };
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
  // PDF 按页建索引：批注只可能在它自己那一页里，跨页搜索既慢又容易钉到别的页的同名句
  const pages = new Map([...root.querySelectorAll(".pdf-page")].map((el) => [Number(el.dataset.page), el]));
  for (const annotation of state.annotations) {
    if (annotation.region) continue; // 区域批注不参与文本锚定
    const scope = Number.isFinite(annotation.pageIndex) && pages.has(annotation.pageIndex)
      ? pages.get(annotation.pageIndex)
      : root;
    const index = buildIndex(scope); // 每条重建：wrapRange 会改变 DOM 文本节点
    const hit = locate(index, annotation);
    annotation.__lost = !hit;
    annotation.__drifted = Boolean(hit && hit.drifted);
    if (!hit) {
      if (annotation.status === "active") {
        if (annotation.anchorStatus !== 'missing') {
          annotation.anchorStatus = 'missing';
          await patch(annotation.id, { anchorStatus: 'missing', event: 'anchor_lost' }); decayed += 1;
        }
      }
      continue;
    }
    if (annotation.anchorStatus === 'missing') { annotation.anchorStatus = 'located'; await patch(annotation.id, { anchorStatus: 'located', event: 'anchor_relocated' }); }
    wrapRange(index.raw, hit.start, hit.end, annotation.id);
  }
  root.querySelectorAll(".anchor").forEach((node) => {
    const item = state.annotations.find((entry) => entry.id === node.dataset.ann);
    node.dataset.status = item ? item.status : "active";
    node.dataset.kind = item && (item.kind === "highlight" || item.kind === "strike") ? item.kind : "comment";
    if (node.closest(".pdf-text") && node.dataset.kind === "comment") {
      node.title = `${item?.status === "addressed" ? "已修改" : "待修改"} · ${item?.body || "点击查看批注"}`;
    }
  });
  // 补充决策：保留 = 页边低对比小标记（md/text 文档；正文只留极淡底）。
  // 每个保留范围一个标记（跨行不重复堆图标——按 annId 去重），可键盘聚焦，点击弹浮卡
  root.querySelectorAll(".retain-gutter-mark").forEach(n => n.remove());
  if (state.mode === "text") {
    const seen = new Set();
    for (const node of root.querySelectorAll('.anchor[data-kind="highlight"]')) {
      const annId = node.dataset.ann;
      if (!annId || seen.has(annId)) continue;
      seen.add(annId);
      const mark = document.createElement("button");
      mark.className = "retain-gutter-mark";
      mark.type = "button";
      mark.title = "已保留 · Agent 不应改写（点击查看/取消）";
      mark.setAttribute("aria-label", "已保留标记");
      mark.addEventListener("click", (event) => {
        event.stopPropagation();
        const r = node.getBoundingClientRect();
        const wr = worldRect(node);
        openAnchorCard(annId, { x: wr.x, y: wr.y, w: wr.w, h: wr.h });
      });
      node.appendChild(mark);
    }
  }
  return decayed;
}

/* ---------------- 卡片 ---------------- */
/* S3 两态呈现：待修改 / 已修改；异常是说明不是状态（需确认位置）。
   编号/轮次/权重退到内部数据，主界面不再展示（详情按需查 API）。 */
const LABELS = { active: "", addressed: "已修改 ✓", stale: "需确认位置", deprecated: "已删除" };

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
  // U03：保留的锚点丢失 = 「待定位」（要求仍有效），与普通批注的「已过期」语义分开
  const LOST_BADGE = annotation.kind === "highlight" && (annotation.anchorStatus === "missing" || annotation.status === "stale")
    ? '<span class="c-kind" style="color:#8a6116">待定位</span>' : "";
  const roundNo = Number.isFinite(annotation.round) ? annotation.round : 0;
  const isCurrentRound = roundNo === (state.round ?? 0);
  card.dataset.roundCur = isCurrentRound ? "1" : "0";
  const visibleNo = displayNo(annotation); // 内部引用用；主界面不再展示编号
  // U04 紧凑列表：高频操作就地可点，低频操作（移到历史/以此为准）收进「⋯」
  let actions;
  if (annotation.kind === "highlight") {
    actions = '<button data-act="delete" class="danger">取消保留</button>';
  } else if (annotation.status === "active") {
    actions = '<button data-act="edit">编辑</button><button data-act="addressed">已处理</button><button data-act="delete" class="danger">删除</button>'
      + (conflicting.length ? '<button data-act="supersede">以此为准</button>' : '')
      + '<details class="c-more"><summary title="更多">⋯</summary><div><button data-act="deprecated">移到历史</button></div></details>';
  } else {
    actions = '<button data-act="revive">恢复</button><button data-act="delete" class="danger">删除</button>';
  }
  card.innerHTML = `
    <div class="c-head">
      ${KIND_BADGE[annotation.kind] || ""}${LOST_BADGE}
      ${annotation.status === "addressed" ? '<span class="c-done">已修改 ✓</span>' : ""}
      ${annotation.status === "stale" ? '<span class="c-badge" style="color:#8a6116">需确认位置</span>' : ""}
      ${annotation.status !== "active" ? `<span class="c-badge">${LABELS[annotation.status] || annotation.status}</span>` : ""}
      ${annotation.__drifted ? '<span class="c-flag">漂移</span>' : ""}
      ${annotation.__lost ? '<span class="c-flag">锚点失效</span>' : ""}
      ${conflicting.length ? `<span class="c-conflict" title="与 ${conflicting.map(displayNo).join("、")} 针对同一处原文，需裁定">冲突 ${conflicting.map(displayNo).join("/")}</span>` : ""}

    </div>
    <div class="c-body">${escapeHtml(annotation.body || (annotation.kind === "highlight" ? "（标记保留 · 这段内容要保留）" : annotation.kind === "strike" ? "（删除线标记 · 建议删除此段）" : ""))}</div>
    <div class="c-quote">${escapeHtml(annotation.quote || "（原文已变更，锚点失效）")}</div>
    <div class="c-actions">${actions}</div>`;

  card.addEventListener("click", (event) => { if (event.target.closest(".c-quote")) card.classList.toggle("quote-open"); }, true);
  card.addEventListener("mouseenter", () => { state.hovered = annotation.id; drawLines(); applyPeek(annotation.id); });
  card.addEventListener("mouseleave", () => { state.hovered = null; drawLines(); clearPeek(); });

  /* B02：选中与定位一律放到 click 阶段，且先排除「拖选文字」和「点引用」两种意图。
     旧实现把 selectCard 挂在 mousedown，而 selectCard 在切换分组时会重建整个列表——
     于是 pointerdown 到 click 之间被点的那张卡已经被换掉，点击结果取决于运气。
     另外拖选卡片文字后浏览器仍会补发一个 click，旧代码会据此把正文滚走。 */
  let cardPointerStart = null;
  card.addEventListener("mousedown", (event) => {
    if (event.target.closest("button, textarea, summary, details, a")) return;
    event.stopPropagation();
    cardPointerStart = { x: event.clientX, y: event.clientY, moved: false };
    if (!isCanvasMode()) return; // 阅读态卡片不可拖拽（规格 §3.6）
    const startX = event.clientX;
    const startY = event.clientY;
    const originX = parseFloat(card.style.left);
    const originY = parseFloat(card.style.top);
    card.classList.add("dragging");
    const move = (moveEvent) => {
      if (cardPointerStart) cardPointerStart.moved = true;
      card.style.left = `${originX + (moveEvent.clientX - startX) / view.zoom}px`;
      card.style.top = `${originY + (moveEvent.clientY - startY) / view.zoom}px`;
      // 同步内存坐标：drawLines 读的是 annotation.x/y——不同步的话引导线在拖动全程钉在旧位置
      annotation.x = parseFloat(card.style.left);
      annotation.y = parseFloat(card.style.top);
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
    // 按钮/输入/折叠/引用各有自己的职责：点它们不做「选中 + 定位」
    if (event.target.closest("button, textarea, summary, details, a, .c-quote")) return;
    const start = cardPointerStart;
    cardPointerStart = null;
    if (start && (start.moved || Math.abs(event.clientX - start.x) > 4 || Math.abs(event.clientY - start.y) > 4)) return; // 拖过：不是点击
    const selection = window.getSelection();
    if (selection && String(selection).trim() && card.contains(selection.anchorNode)) return; // 正在复制卡内文字：不跳正文
    // 选中放在 click 阶段，且不重建列表：卡片已经在眼前，重建只会吃掉这次点击
    selectCard(annotation.id, { rebuildIfHidden: false });
    const mark = findAnchor(annotation.id);
    if (!mark) return toast("这条批注的原文已找不到，已自动标记过期");
    mark.classList.remove("flash");
    void mark.offsetWidth;
    mark.classList.add("flash");
    const rect = worldRect(mark);
    centerOn(rect.x + rect.w / 2, rect.y + rect.h / 2);
  });

  return card;
}

/* U04/决策16：卡片按钮走 #cards 容器事件委托——卡片列表会被筛选/选中重建，
   逐元素绑定的 click 会在重建瞬间丢失（「取消保留」间歇性无效的根因）。
   annotation 一律按 id 现查，不闭包旧对象。 */
async function handleCardAction(button) {
  const card = button.closest(".card");
  if (!card) return;
  const annotation = state.annotations.find(entry => entry.id === card.dataset.id);
  if (!annotation) return;
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
    await loadAnnotations({ rerender: false });
    toast(`${displayNo(annotation)} 已替代 ${losers.map(displayNo).join("、")}（旧批注保留在历史中）`);
    return;
  }
  if (act === "edit") { startCardEdit(card, annotation); return; }
  if (act === "save-edit") {
    const ta = card.querySelector(".card-edit");
    if (!ta) return;
    await checkedFetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: annotation.id, body: ta.value, event: "edited" }),
    });
    await loadAnnotations({ rerender: false });
    toast("批注已更新");
    return;
  }
  if (act === "cancel-edit") { await loadAnnotations({ rerender: false }); return; }
  if (act === "delete") {
    await checkedFetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: annotation.id }),
    });
    await loadAnnotations({ rerender: false });
    // S2：删除撤销——暂存整条数据，8 秒内可一键恢复
    const undo = async () => {
      await checkedFetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...annotation, status: "active" }),
      });
      await loadAnnotations({ rerender: false });
      toast("已撤销删除");
    };
    showUndoToast(annotation.kind === "highlight" ? "已取消保留" : "批注已删除", undo);
    return;
  }
  const next = act === "addressed" ? { status: "addressed", weight: 0.5 }
    : act === "deprecated" ? { status: "deprecated", weight: 0 }
    : { status: "active", weight: 1 };
  await patch(annotation.id, { ...next, event: act });
  await loadAnnotations({ rerender: false });
}

/* ---------- U05/飞书式交互：点击正文锚点 → 就地浮出批注卡 ---------- */
let floatCard = null; // { el, annId }
function closeAnchorCard() {
  if (!floatCard) return;
  floatCard.el.remove();
  floatCard = null;
}
function openAnchorCard(annotationId, anchorRectWorld) {
  closeAnchorCard();
  const item = state.annotations.find(e => e.id === annotationId);
  if (!item) return;
  const KIND = { highlight: '<span class="c-kind hl">保留</span>', strike: '<span class="c-kind st">删除线</span>', region: '<span class="c-kind rg">区域</span>' };
  const lost = item.kind === "highlight" && (item.anchorStatus === "missing" || item.status === "stale");
  const body = item.body || (item.kind === "highlight" ? "（标记保留 · 这段内容要保留）" : item.kind === "strike" ? "（删除线标记 · 建议删除此段）" : "");
  const el = document.createElement("div");
  el.className = "anchor-float-card";
  el.innerHTML = `
    <div class="c-head">
      ${KIND[item.kind] || ""}${lost ? '<span class="c-kind" style="color:#8a6116">待定位</span>' : ""}
      <button class="fc-close icon" title="关闭">✕</button>
    </div>
    <div class="c-body">${escapeHtml(body)}</div>
    ${item.quote ? `<div class="c-quote">${escapeHtml(item.quote.slice(0, 90))}</div>` : ""}
    <div class="c-actions">
      ${item.kind === "highlight"
        ? '<button data-act="delete" class="danger">取消保留</button>'
        : item.status === "active"
          ? '<button data-act="edit">编辑</button><button data-act="addressed">已处理</button><button data-act="delete" class="danger">删除</button>'
          : '<button data-act="revive">恢复</button><button data-act="delete" class="danger">删除</button>'}
    </div>`;
  // 定位：锚点下方 10px；下方空间不足翻上方；左右 clamp 到正文区
  const world = $("world");
  const top = anchorRectWorld.y + anchorRectWorld.h + 10;
  const width = 300;
  const left = Math.max(4, Math.min(anchorRectWorld.x - 20, (viewportContentWidth() || 900) - width - 12));
  el.style.left = `${left}px`;
  el.style.top = `${Math.max(4, top)}px`;
  el.style.width = `${width}px`;
  world.appendChild(el);
  floatCard = { el, annId: annotationId };
  el.addEventListener("click", (event) => {
    if (event.target.closest(".fc-close")) { closeAnchorCard(); return; }
    const button = event.target.closest("button[data-act]");
    if (!button) return;
    event.stopPropagation();
    handleCardAction(button).then(() => closeAnchorCard()).catch(error => toast("操作失败：" + String(error?.message || error)));
  });
  // 编辑态：浮卡内 textarea ⌘S 保存后关闭（loadAnnotations 会刷新）
  el.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeAnchorCard(); }
  });
  state.selected = annotationId;
  reportUiState();
}
function viewportContentWidth() {
  const vp = $("viewport");
  return vp ? vp.clientWidth : window.innerWidth;
}
// 点浮卡外部关闭（捕获阶段，避免与选区/锚点点击竞争）
document.addEventListener("mousedown", (event) => {
  if (!floatCard) return;
  if (event.target.closest(".anchor-float-card") || event.target.closest(".anchor[data-ann]")) return;
  closeAnchorCard();
}, true);
window.addEventListener("keydown", (event) => { if (event.key === "Escape") closeAnchorCard(); });

/* B02：rebuildIfHidden=false 用于「用户直接点右栏里的卡」——卡已经在眼前，没有理由重建。
   重建会让 pointerdown 到 click 之间被点的那张卡被换掉，点击结果变成随机（实测 20 次里错 6 次）。
   只有从正文侧选中一条不在当前分组里的批注时，才需要切分组重画。 */
function selectCard(id, { rebuildIfHidden = true } = {}) {
  state.selected = id;
  const selected = state.annotations.find(a => a.id === id);
  if (rebuildIfHidden && selected && feedbackGroup(selected) !== feedbackFilter) {
    feedbackFilter = feedbackGroup(selected);
    renderCards();
  }
  document.querySelectorAll(".card").forEach((node) => node.classList.toggle("selected", node.dataset.id === id));
  drawLines();
  reportUiState();
}

/* 点击正文锚点（含 PDF 文字层）→ 就地浮出批注卡 */
$("doc").addEventListener("click", (event) => {
  if (isCanvasMode()) return; // 画布有自己的批注卡体系
  const mark = event.target.closest(".anchor[data-ann]");
  if (!mark || event.target.closest("button, textarea")) return;
  const rect = mark.getBoundingClientRect();
  const wr = worldRect(mark);
  openAnchorCard(mark.dataset.ann, { x: wr.x, y: wr.y, w: wr.w, h: wr.h });
});

$("cards").addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-act]");
  if (!button) return;
  event.stopPropagation();
  try { await handleCardAction(button); }
  catch (error) { toast("操作失败：" + String(error?.message || error)); }
});

function renderCards() {
  const host = $("cards-body"); // 列表容器与静态头部分离（innerHTML 清空不抹头部）
  host.innerHTML = "";
  const pendingCount = state.annotations.filter(item => feedbackGroup(item) === "pending").length;
  $("stat-count").textContent = state.annotations.length;
  $("stat-active").textContent = pendingCount; // 「当前」= 待处理组（与反馈面板计数同源）
  // PDF/图片没有标题结构：不显示「大纲」入口，避免点进去一片空白
  const outlineAvailable = state.mode === "text";
  if (railTab === "outline" && !outlineAvailable) railTab = "feedback";
  if (!isCanvasMode()) {
    host.innerHTML = outlineAvailable
      ? '<div class="rail-tabs" role="tablist" aria-label="大纲与反馈">'
        + '<button role="tab" data-rail-tab="outline"' + (railTab === 'outline' ? ' aria-selected="true"' : '') + '>大纲</button>'
        + '<button role="tab" data-rail-tab="feedback"' + (railTab === 'feedback' ? ' aria-selected="true"' : '') + '>反馈</button>'
        + '</div>'
      : '<div class="feedback-heading"><strong>文档反馈</strong></div>' + feedbackTabs();
    if (railTab === 'outline') { renderOutline(host); return; }
    // PDF/图片分支的 innerHTML 已含反馈头部，不能再追加一次（v1.2.1 静态回归）
    if (outlineAvailable) host.insertAdjacentHTML('beforeend', '<div class="feedback-heading"><strong>文档反馈</strong></div>' + feedbackTabs());
  }
  const visible = isCanvasMode() ? state.annotations : state.annotations.filter(a => feedbackGroup(a) === feedbackFilter);
  if (!isCanvasMode() && feedbackFilter === 'versions') { renderVersions(host); return; }
  if (!isCanvasMode() && feedbackFilter === 'history' && visible.length > 3) {
    // U03：历史默认折叠（超过 3 条才折叠），文字仍可读、可展开
    const details = document.createElement('details');
    details.className = 'history-fold';
    details.innerHTML = `<summary>历史 ${visible.length} 条（点击展开）</summary>`;
    const body = document.createElement('div');
    for (const annotation of visible) body.appendChild(cardElement(annotation));
    details.appendChild(body);
    host.appendChild(details);
  } else {
    for (const annotation of visible) host.appendChild(cardElement(annotation));
  }
  if (!visible.length && !isCanvasMode()) host.insertAdjacentHTML('beforeend', '<p class="feedback-empty">' + (feedbackFilter === 'pending' ? '没有待处理的反馈。选中文字，写下想改的地方。' : feedbackFilter === 'retained' ? '选中文字并点「保留」，留下后续修改不能动的内容。' : '处理过的反馈会留在这里，随时可以追溯。') + '</p>');
}

function renderOutline(host) {
  const list = document.createElement('div');
  list.className = 'outline-list';
  if (!state.outline || !state.outline.length) {
    list.innerHTML = '<p class="feedback-empty">此文档没有标题结构。Markdown 的 # 标题、HTML 的 h1-h3 会出现在这里，点一下跳到对应位置。</p>';
  } else {
    list.innerHTML = state.outline.map(item => `<button class="outline-item lv${item.level}" data-outline-go="${item.idx}" title="${escapeHtml(item.text)}"><span>${String(item.idx + 1).padStart(2, '0')}</span>${escapeHtml(item.text)}</button>`).join('');
  }
  host.appendChild(list);
}

document.addEventListener('click', event => {
  const tab = event.target.closest('[data-rail-tab]');
  if (tab) { railTab = tab.dataset.railTab; renderCards(); return; }
  const go = event.target.closest('[data-outline-go]');
  if (go) goToOutline(Number(go.dataset.outlineGo));
});

/* 版本对照：Agent 改完登记的新版本在这里验收 —— 回答「这一轮改了哪里」 */

async function renderVersions(host) {
  if (!state.path) { host.insertAdjacentHTML('beforeend', '<p class="feedback-empty">先打开一个文档。</p>'); return; }
  let shell = host.querySelector('.version-panel');
  if (!shell) { shell = document.createElement('div'); shell.className = 'version-panel'; host.appendChild(shell); }
  shell.innerHTML = '<div class="vp-loading">载入版本…</div>';
  try {
    const res = await fetch(`/api/versions?p=${encodeURIComponent(state.path)}`);
    const data = await res.json();
    versionState.list = data.versions || [];
  } catch { versionState.list = []; }
  // 选中状态记 id 不记序号：列表会随新增版本移位，按序号验收就是「验收错对象」的根源
  if (!versionState.activeId || !versionState.list.some(item => item.id === versionState.activeId)) {
    versionState.activeId = versionState.list.length ? versionState.list[0].id : null;
  }
  paintVersions(shell);
}

function paintVersions(shell) {
  const list = versionState.list;
  if (!list.length) {
    shell.innerHTML = '<p class="feedback-empty">还没有新版本。Agent 改完文档会登记在这里，原件始终保留。</p>';
    return;
  }
  const active = list.find(item => item.id === versionState.activeId) || list[0];
  versionState.activeId = active.id;
  const statusText = { pending: '待验收', accepted: '已验收', rejected: '已退回' };
  const canRender = RENDERABLE_TEXT.test(active.file || "") && RENDERABLE_TEXT.test(state.path || "");
  shell.innerHTML = `
    <div class="vp-headline">
      <span class="vp-title">这一轮，改了哪里？</span>
      <span class="vp-view-toggle" role="tablist">
        <button data-vp-view="side"${versionState.view === 'side' ? ' aria-selected="true"' : ''}>并排</button>
        <button data-vp-view="rows"${versionState.view === 'rows' ? ' aria-selected="true"' : ''}>逐段</button>
        ${versionState.view === 'side' && canRender ? `<button data-vp-side="${versionState.sideMode === 'render' ? 'text' : 'render'}">${versionState.sideMode === 'render' ? '文本' : '排版'}</button>` : ''}
      </span>
    </div>
    ${reportHtml(versionState.report)}
    <div class="vp-list" role="list">
      ${list.map(item => `<button role="listitem" class="vp-item${item.id === active.id ? ' active' : ''}" data-vp-id="${escapeHtml(item.id)}">
        <span class="vp-round">版本</span>
        <span class="vp-file">${escapeHtml(item.file)}</span>
        <span class="vp-status" data-status="${item.status}">${statusText[item.status] || item.status}</span>
      </button>`).join('')}
    </div>
    <div class="vp-diff">${versionState.loading ? '对照中…' : diffHtml(versionState.diff, active)}</div>
    ${versionState.diffChanged ? '<div class="vp-changed">⚠ 文件内容与登记时不一致：对照反映的是当前文件，验收会被拒绝。</div>' : ''}
    <div class="vp-actions">
      <button class="vp-open primary">继续批注新版本 →</button>
      <button class="vp-accept">验收</button>
      <button class="vp-reject danger">退回</button>
    </div>`;
  shell.querySelectorAll('[data-vp-view]').forEach((button) => button.addEventListener('click', () => {
    versionState.view = button.dataset.vpView;
    paintVersions(shell);
  }));
  shell.querySelectorAll('[data-vp-side]').forEach((button) => button.addEventListener('click', () => {
    versionState.sideMode = button.dataset.vpSide;
    paintVersions(shell);
    if (versionState.sideMode === 'render') ensureRenderedDiff(active);
  }));
  shell.querySelectorAll('[data-sb-gap]').forEach((button) => button.addEventListener('click', () => {
    const hidden = shell.querySelector(`[data-sb-hidden="${button.dataset.sbGap}"]`);
    if (hidden) { hidden.hidden = false; button.remove(); }
  }));
  shell.querySelectorAll('[data-vp-id]').forEach((button) => button.addEventListener('click', async () => {
    versionState.activeId = button.dataset.vpId;
    versionState.diff = null;
    versionState.diffChanged = null;
    paintVersions(shell);
    await loadDiff(shell);
  }));
  shell.querySelector('.vp-open').addEventListener('click', async () => {
    // 「保留的内容持续有效」：继承在服务端事务内完成（按来源批注 id 幂等、逐条核对原文）。
    // 结果如实呈现——继承几条、缺几条、哪些原文找不到，绝不静默成功
    const target = active;
    try {
      const res = await fetch(`/api/versions?p=${encodeURIComponent(state.path)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'carry', to: target.file }),
      });
      const data = await res.json();
      if (!res.ok) toast(`保留继承失败（${data.error || res.status}）——已打开新版本，请人工核对保留要求`);
      else if (data.missing && data.missing.length) toast(`继承 ${data.carried.length} 条保留；⚠ ${data.missing.length} 条原文在新版找不到，已标记待确认`);
      else if (data.carried && data.carried.length) toast(`已把 ${data.carried.length} 条「保留」要求带到新版本`);
      else if (data.skipped && data.skipped.length) toast(`保留要求此前已继承（${data.skipped.length} 条）`);
      else toast('上一版没有生效中的保留要求');
    } catch { toast('保留继承请求失败——已打开新版本，请人工核对保留要求'); }
    openDoc(target.file);
  });
  shell.querySelector('.vp-accept').addEventListener('click', () => decideVersion(shell, 'accepted'));
  shell.querySelector('.vp-reject').addEventListener('click', () => decideVersion(shell, 'rejected'));
  if (versionState.diff === null && !versionState.loading) loadDiff(shell);
  // srcdoc 不能内嵌进 innerHTML（内容无转义）：面板渲染完成后对占位 iframe 赋值
  if (versionState.view === 'side' && versionState.sideMode === 'render') {
    const rendered = versionState.rendered;
    if (rendered && rendered.left && rendered.right) {
      const [leftPane, rightPane] = shell.querySelectorAll('.sb-pane');
      if (leftPane) leftPane.srcdoc = rendered.left;
      if (rightPane) rightPane.srcdoc = rendered.right;
    } else if (active && RENDERABLE_TEXT.test(active.file || "") && RENDERABLE_TEXT.test(state.path || "")) {
      ensureRenderedDiff(active);
    }
  }
}

function reportHtml(report) {
  if (!report) return '';
  const parts = [];
  if (report.responded) parts.push(`回应了 ${report.responded} 条反馈`);
  if (report.retained) {
    if (report.retained.total === 0) parts.push('本轮没有生效中的保留要求');
    else {
      if (report.retained.missing > 0) parts.push(`⚠ ${report.retained.missing}/${report.retained.total} 处保留内容在新稿中未找到，待确认`);
      if (report.retained.ambiguous > 0) parts.push(`${report.retained.ambiguous} 处保留内容多处出现，待确认`);
      if (report.retained.ok > 0) parts.push(`${report.retained.ok} 处保留内容未改动`);
    }
  }
  if (report.basis === 'live') parts.push('此版本没有快照，对照基于当前文件');
  return parts.length ? `<div class="vp-report">${parts.map(escapeHtml).join(' · ')}</div>` : '';
}

function sideBySideHtml(diff) {
  const rows = diff.sideBySide || [];
  // 连续未变化的段落折叠成一行，点开才展开——并排视图也要一眼看到「变化」
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 4) out.push({ type: 'gap', count: run.length, rows: run });
    else run.forEach(row => out.push(row));
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'same') run.push(row);
    else { flush(); out.push(row); }
  }
  flush();
  const cell = (text, kind) => `<div class="sb-cell ${kind}">${text ? escapeHtml(text) : '&nbsp;'}</div>`;
  return `
    <div class="sb-head"><span>修改前</span><span>修改后</span></div>
    <div class="sb-body">${out.map((row, index) => row.type === 'gap'
      ? `<button class="sb-gap" data-sb-gap="${index}">⋯ 未变化的 ${row.count} 段（点开）</button><div class="sb-hidden" data-sb-hidden="${index}" hidden>${row.rows.map(r => `<div class="sb-row same"><div class="sb-cell">${escapeHtml(r.left)}</div><div class="sb-cell">${escapeHtml(r.right)}</div></div>`).join('')}</div>`
      : `<div class="sb-row ${row.type}">${cell(row.left, row.type === 'changed' || row.type === 'removed' ? row.type : 'same')}${cell(row.right, row.type === 'changed' ? 'changed' : row.type === 'added' ? 'added' : 'same')}</div>`
    ).join('')}</div>`;
}

function diffHtml(diff, active) {
  if (!diff) return `<p class="vp-hint">${escapeHtml(active && active.note ? active.note : '这一轮改了哪里：展开对照查看。')}</p>`;
  if (diff.binary) return '<p class="vp-hint">二进制成品（PDF/DOCX 等）无法逐段对照——请打开新文件人工查看。</p>';
  const { rows, removed, summary } = diff;
  if (versionState.view === 'side') {
    const summaryLine = `<div class="vp-summary">新增 ${summary.added} 段 · 删除 ${summary.removed} 段 · 未变化 ${summary.unchanged} 段${diff.truncated ? ' · 超长文档仅对照前 2000 段' : ''}</div>`;
    if (versionState.sideMode === 'render') {
      const rendered = versionState.rendered;
      if (!rendered || !rendered.left || !rendered.right) return `${summaryLine}<p class="vp-hint">排版渲染中…（可切「文本」直接看段落对照）</p>`;
      return `${summaryLine}
        <div class="sb-render">
          <iframe class="sb-pane" sandbox="" referrerpolicy="no-referrer" title="修改前（排版）"></iframe>
          <iframe class="sb-pane" sandbox="" referrerpolicy="no-referrer" title="修改后（排版）"></iframe>
        </div>
        <div class="sb-render-note">排版视图不执行脚本；文本级逐段对照切「文本」。</div>`;
    }
    return `${summaryLine}${sideBySideHtml(diff)}`;
  }
  // 逐段视图：变化全量展示（不截断）；「未变化」折叠可展开，与「保留要求」用词区分
  return `
    <div class="vp-summary">新增 ${summary.added} 段 · 删除 ${summary.removed} 段 · 未变化 ${summary.unchanged} 段${diff.truncated ? ' · 超长文档仅对照前 2000 段' : ''}</div>
    <div class="vp-rows">
      ${removed.map(line => `<div class="vp-row removed"><s>${escapeHtml(line)}</s></div>`).join('')}
      ${rows.filter(row => row.type === 'added').map(row => `<div class="vp-row added"><b>+</b> ${escapeHtml(row.text)}</div>`).join('')}
    </div>
    ${rows.some(row => row.type === 'same') ? `<details class="vp-unchanged"><summary>未变化的 ${summary.unchanged} 段（点开查看）</summary>${rows.filter(row => row.type === 'same').map(row => `<div class="vp-row same">${escapeHtml(row.text)}</div>`).join('')}</details>` : ''}`;
}

async function loadDiff(shell) {
  const active = versionState.list.find(item => item.id === versionState.activeId);
  if (!active) return;
  versionState.loading = true;
  try {
    const res = await fetch(`/api/versions/diff?p=${encodeURIComponent(state.path)}&file=${encodeURIComponent(active.file)}&id=${encodeURIComponent(active.id)}`);
    const data = await res.json();
    versionState.diff = data.diff || null;
    versionState.diffChanged = data.changed === true;
    versionState.report = { responded: data.responded || 0, retained: data.retained || null, basis: data.basis };
  } catch { versionState.diff = null; versionState.diffChanged = null; versionState.report = null; }
  versionState.loading = false;
  paintVersions(shell);
  if (versionState.view === 'side' && versionState.sideMode === 'render' && RENDERABLE_TEXT.test(active.file || "") && RENDERABLE_TEXT.test(state.path || "")) {
    ensureRenderedDiff(active);
  }
}

async function decideVersion(shell, status) {
  const active = versionState.list.find(item => item.id === versionState.activeId);
  if (!active) return;
  const res = await fetch(`/api/versions?p=${encodeURIComponent(state.path)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'decide', id: active.id, status }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => ({}));
    toast(detail.error === 'version-content-changed' ? '文件内容与登记时不一致，验收已阻止——请重新对照' : `操作失败：${detail.error || res.status}`);
  } else {
    const data = await res.json().catch(() => ({}));
    if (status === 'rejected' && Array.isArray(data.reopened) && data.reopened.length) {
      toast(`已退回 · ${data.reopened.length} 条已处理反馈重新待处理`);
      await loadAnnotations();
    } else {
      toast(status === 'accepted' ? '已验收 · 可继续在新版本上批注' : '已退回 · 让 Agent 再改一版');
    }
  }
  await renderVersions(shell);
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
      await loadAnnotations({ rerender: false });
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
  // 文本文档（md/txt/docx/html）阅读模式不画引导线：卡片是固定侧栏（线坐标系失效），
  // 且必须连 SVG 层一起隐藏——12000px 画布会把 overflow:auto 的正文区撑出假横滚。
  // 图片/PDF 的区域线与画布线保留
  const textFamily = state.mode === "text" || state.mode === "docx" || state.mode === "html";
  if (textFamily && !isCanvasMode()) { svg.innerHTML = ""; svg.style.display = "none"; return; }
  svg.style.display = "";
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
    const color = { active: "#262626", addressed: "#10a37f", stale: "#a8842c", deprecated: "#a3a3a3" }[annotation.status] || "#a3a3a3";
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
    const color = annotation.status === "active" ? "#d64545" : "#a8842c";
    context.strokeStyle = color;
    context.lineWidth = Math.max(2, scaleUnit * 0.003);
    context.strokeRect(x, y, w, h);
    const font = Math.round(scaleUnit * 0.024);
    context.font = `600 ${font}px -apple-system, Helvetica, sans-serif`;
    const visibleNo = displayNo(annotation); // 内部引用用；主界面不再展示编号
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
      : "- 文字级小修直接改文件（批注位置用 quote 上下文定位）；整段/整页的大改写可另存为新版本文件放在原文件旁边（如 原名-v2.ext），不要覆盖原件——人会在「版本对照」里验收后再决定采用哪一版",
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
const ARROW_COLORS = { red: "#d64545", orange: "#b45309", yellow: "#ca8a04" };

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
  await checkedFetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
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

async function waitForPdfRenderer(timeout = 20000) { // 6s 在高负载下不够，会误报「渲染器未能加载」并放弃整篇渲染
  const start = Date.now();
  while (!window.renderPdfToContainer && Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return Boolean(window.renderPdfToContainer);
}

/* ================= PPTX：自动逐页预览 + 页级区域批注 =================
   三条产品红线：
   1) 转换在本地完成，原件一个字节都不动；产物只进 .marginalia/pptx-cache/。
   2) 批注锚在 **slideId**（幻灯片创建时分配的稳定 id）上，不是页码。
      页码会随增删/重排漂移，slideId 不会；slideId 找不到就标「待定位」，绝不猜一个页码贴上去。
   3) 没有引擎 / 转换失败 / 缺字体，一律如实提示并说明影响；绝不用近似渲染冒充原稿。 */
const pptxState = { url: null, slides: [], slideIdToPage: new Map(), page: 1, info: null, fontsChecked: null };

/** 批注 → 当前应落在第几页。返回 {page} / {page:0, missing:true}（待定位）/ legacy（只有页码，不可靠） */
function pptxLocate(annotation) {
  const region = annotation.region;
  if (!region) return null;
  if (region.slideId) {
    const page = pptxState.slideIdToPage.get(String(region.slideId));
    if (Number.isFinite(page)) {
      return { page, movedFrom: Number.isFinite(region.page) && region.page !== page ? region.page : 0 };
    }
    return { page: 0, missing: true }; // 这张幻灯片不在了 —— 待定位，不猜
  }
  return { page: Number(region.page) || 1, legacy: true };
}

function pptxSlideIdOf(page) {
  const slide = pptxState.slides.find((item) => item.index === page);
  return slide ? String(slide.slideId) : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchPptxInfo(force) {
  const query = `/api/pptx?p=${encodeURIComponent(state.path)}${force ? "&force=1" : ""}`;
  const response = await fetch(query);
  return response.json();
}

/** 转换是后台任务（可能几十秒）：轮询 /api/pptx-job 直到出结果 */
async function pptxAwaitJob(epoch, onTick) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await sleep(700);
    if (epoch !== docEpoch) return null;
    const job = await fetch(`/api/pptx-job?p=${encodeURIComponent(state.path)}`).then((r) => r.json()).catch(() => null);
    if (!job || job.status === "idle") return fetchPptxInfo(false); // 任务记录已清，重新问一次
    if (job.status === "converting") { onTick?.(job); continue; }
    return job;
  }
  return { status: "failed", detail: "转换超时（超过 180 秒），请重试或检查文件是否过大/损坏。" };
}

function pptxFontBanner(info) {
  const used = info.fontsUsed || [];
  if (!used.length) return "";
  const checked = pptxState.fontsChecked;
  if (checked && checked.status === "ok" && checked.missing?.length) {
    return `<div class="pptx-banner warn"><b>缺字体：${checked.missing.map(escapeHtml).join("、")}</b>
      —— 预览里这些字会被替换成别的字体，排版可能与你看到的原稿不一致。<b>不要把这份预览当成原稿核对细节。</b>
      <button class="pptx-link" id="pptx-font-recheck">重新检查</button></div>`;
  }
  if (checked && checked.status === "ok" && !checked.missing?.length) {
    return `<div class="pptx-banner ok">已检查 ${checked.checked} 种字体，本机都有。
      <button class="pptx-link" id="pptx-font-recheck">重新检查</button></div>`;
  }
  if (checked && checked.status === "unknown") {
    return `<div class="pptx-banner warn">字体可用性检查失败（${escapeHtml(checked.reason || "未知原因")}）—— 无法确认是否缺字体。
      <button class="pptx-link" id="pptx-font-recheck">重试</button></div>`;
  }
  return `<div class="pptx-banner">这份 PPT 用到了：${used.slice(0, 8).map(escapeHtml).join("、")}${used.length > 8 ? " 等" : ""}。
    <button class="pptx-link" id="pptx-font-check">检查本机是否缺字体</button></div>`;
}

function renderPptxShell(host) {
  host.innerHTML = `
    <div class="pptx-view">
      <div class="pptx-head" id="pptx-head"></div>
      <div class="pptx-body">
        <aside class="pptx-rail" id="pptx-rail" aria-label="幻灯片缩略图"></aside>
        <main class="pptx-stage" id="pptx-stage">
          <div class="slide-frame" id="slide-frame">
            <div class="slide-canvas" id="slide-canvas"></div>
            <div class="region-layer" id="slide-regions"></div>
          </div>
        </main>
      </div>
    </div>`;
}

function showOfficeSetup(onEnable) {
  const dialog = document.createElement('dialog');
  dialog.className = 'office-editor office-setup';
  dialog.setAttribute('aria-label', 'PPT 原版预览设置');
  dialog.innerHTML = `<p class="journal-eyebrow">可选扩展 · 在本机运行</p><h2>让 PPT 显示原来的样子</h2>
    <p>文字查看和小范围改字不需要额外下载。原版幻灯片预览需要单独安装 <strong>LibreOffice</strong>，不会打包进 CoEditor。</p>
    <p class="office-notice">本机安装实测约 804 MB，其他版本会不同；首次转换可能较慢。转换结果可能受字体、动画和复杂排版影响，不保证与 PowerPoint 完全一致。</p>
    <ol><li>从 LibreOffice 官网下载并安装，再尝试打开一次。</li><li>若 macOS 提示“无法验证开发者”，先核对下载来源；确认可信后，可查看「系统设置 → 隐私与安全」中的对应提示，自行决定是否“仍要打开”。不同版本的提示次数不固定。</li><li><strong>如果提示包含恶意软件、会损坏电脑或文件已损坏，不要反复允许；停止打开，核对来源并重新下载。</strong></li></ol>
    <p class="office-notice">CoEditor 不会替你绕过安全检查、关闭 Gatekeeper 或清除隔离标记。</p>
    <p><a href="https://www.libreoffice.org/download/download-libreoffice/" target="_blank" rel="noopener noreferrer">官方下载 ↗</a> · <a href="https://support.apple.com/102445" target="_blank" rel="noopener noreferrer">Apple 安全说明 ↗</a></p>
    <footer><button class="chip" data-disable>仅用文字模式</button><button class="chip" data-cancel>关闭</button><button class="chip" data-enable>已安装，启用预览</button></footer>`;
  dialog.querySelector('[data-disable]').onclick = () => {
    try { localStorage.removeItem('coeditor-office-preview-optin'); } catch {}
    dialog.close();
    if (state.mode === 'pptx') renderPptxNoEngine(document.getElementById('doc'), {});
  };
  dialog.querySelector('[data-cancel]').onclick = () => dialog.close();
  dialog.querySelector('[data-enable]').onclick = () => {
    try { localStorage.setItem('coeditor-office-preview-optin', '1'); } catch {}
    dialog.close(); onEnable?.();
  };
  dialog.addEventListener('close', () => dialog.remove(), {once:true});
  document.body.append(dialog); dialog.showModal();
}

async function renderPptx(host, enabled = false) {
  host.classList.add("pptx-view-host");
  let optedIn = enabled;
  try { optedIn ||= localStorage.getItem('coeditor-office-preview-optin') === '1'; } catch {}
  if (!optedIn) {
    host.innerHTML = '<div class="office-welcome"><p class="journal-eyebrow">演示文稿</p><h2>先读内容，或查看完整幻灯片</h2><p>文字阅读与修改无需额外软件。需要原版排版时，再启用本地转换扩展。</p><div class="office-choices"><button class="chip" data-text>直接看文字</button><button class="chip" data-preview>设置幻灯片预览</button></div></div>';
    host.querySelector('[data-text]').onclick = () => renderPptxNoEngine(host, {});
    host.querySelector('[data-preview]').onclick = () => {
      const path = state.path;
      showOfficeSetup(() => { if (path === state.path) renderPptx(host, true); });
    };
    return;
  }
  const epoch = docEpoch;
  host.innerHTML = '<div class="pptx-status">正在读取这份 PPT…</div>';
  pptxState.fontsChecked = null;
  let info = await fetchPptxInfo(false).catch(() => null);
  if (epoch !== docEpoch) return;
  if (info && info.status === "converting") {
    host.innerHTML = '<div class="pptx-status">正在本地转换预览（不联网、不改原件）…</div>';
    info = await pptxAwaitJob(epoch, (job) => {
      const sec = Math.round((job.elapsedMs || 0) / 1000);
      const el = host.querySelector(".pptx-status");
      if (el) el.textContent = `正在本地转换预览… ${sec}s`;
    });
    if (epoch !== docEpoch || !info) return;
  }
  if (!info) { host.innerHTML = '<div class="pptx-banner err">无法读取这份 PPT。</div>'; return; }

  pptxState.info = info;
  pptxState.slides = info.slides || [];
  pptxState.slideIdToPage = new Map(pptxState.slides.map((s) => [String(s.slideId), s.index]));
  pptxState.url = info.pdfUrl || null;

  if (info.status === "no-engine") return renderPptxNoEngine(host, info);
  if (info.status !== "ready") return renderPptxFailed(host, info);

  renderPptxShell(host);
  if (!pptxState.page || pptxState.page > pptxState.slides.length) pptxState.page = 1;
  await paintPptxSlide(epoch);
}

async function renderPptxNoEngine(host, info) {
  const epoch = docEpoch;
  try {
    const response = await fetch(`/api/office-text?p=${encodeURIComponent(state.path)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取失败');
    if (epoch !== docEpoch) return;
    host.innerHTML = '<div class="office-text-preview"><h2>PPT 文字内容</h2><p class="office-notice">这是文字提取视图，不包含原版排版、图表和图片。可点顶栏「修改文字」另存修改版。原版逐页预览需要可选的 LibreOffice，本工具不会自动安装。</p></div>';
    const root = host.firstElementChild;
    for (const part of [...new Set(data.segments.map(s => s.part))]) {
      const section = document.createElement('section');
      const heading = document.createElement('h3');
      heading.textContent = `幻灯片内容 · ${part.split('/').pop()}`;
      section.append(heading);
      for (const segment of data.segments.filter(s => s.part === part && s.text.trim())) {
        const p = document.createElement('p'); p.textContent = segment.text; section.append(p);
      }
      root.append(section);
    }
    return;
  } catch (error) { if (epoch !== docEpoch) return; }
  const mb = info.downloadBytes ? `（约 ${Math.round(info.downloadBytes / 1048576)} MB）` : "";
  const pages = (info.slides || []).length;
  host.innerHTML = `
    <div class="pptx-empty">
      <div class="pptx-banner err"><b>无法生成逐页预览：本机没有可用的转换引擎。</b></div>
      <p class="pptx-lead">CoEditor 不会用近似渲染冒充原稿，也不会替你安装软件。要启用预览，需要你本机有一个本地转换引擎（LibreOffice）：</p>
      <pre class="pptx-cmd">${escapeHtml(info.installHint || "brew install --cask libreoffice")}</pre>
      <p class="pptx-note">体积${mb}。装好后回到这里重新打开这份 PPT 即可，无需其它设置。</p>
      ${pages ? `<p class="pptx-note">已读到这份 PPT 的结构：<b>${pages} 页</b>（幻灯片 id：${(info.slides || []).slice(0, 12).map((s) => escapeHtml(s.slideId)).join("、")}${pages > 12 ? " …" : ""}）。
        没有预览就不能在上面框选批注 —— 现在只能先装引擎，或改用图片批注的替代流程。</p>` : ""}
      ${pptxFontBanner(info)}
    </div>`;
  bindPptxFontCheck(host, info);
}

function renderPptxFailed(host, info) {
  host.innerHTML = `
    <div class="pptx-empty">
      <div class="pptx-banner err"><b>转换失败：${escapeHtml(info.detail || "未知原因")}</b></div>
      <p class="pptx-note">预览没生成，所以不会展示任何「看起来像但不确定」的内容。原件未被修改。</p>
      ${info.stderr ? `<pre class="pptx-cmd">${escapeHtml(String(info.stderr).slice(0, 1500))}</pre>` : ""}
      ${(info.warnings || []).length ? `<pre class="pptx-cmd">${escapeHtml(info.warnings.join("\n").slice(0, 1500))}</pre>` : ""}
      <button class="pptx-btn" id="pptx-retry">重试转换</button>
    </div>`;
  host.querySelector("#pptx-retry")?.addEventListener("click", () => renderPptx(host));
}

function bindPptxFontCheck(host, info) {
  const run = async (refresh) => {
    const button = host.querySelector("#pptx-font-check") || host.querySelector("#pptx-font-recheck");
    if (button) { button.disabled = true; button.textContent = "检查中（首次约 7 秒）…"; }
    const result = await fetch(`/api/pptx/fonts?p=${encodeURIComponent(state.path)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ refresh: refresh === true }),
    }).then((r) => r.json()).catch(() => ({ status: "unknown", reason: "请求失败" }));
    pptxState.fontsChecked = result;
    // 只换横幅，不重渲染整页（避免闪掉当前幻灯片）
    const old = host.querySelector(".pptx-banner.warn, .pptx-banner.ok");
    if (old) {
      const wrap = document.createElement("div");
      wrap.innerHTML = pptxFontBanner({ ...info, fontsUsed: result.fonts || info.fontsUsed });
      old.replaceWith(wrap.firstElementChild || wrap);
      bindPptxFontCheck(host, info);
    }
  };
  host.querySelector("#pptx-font-check")?.addEventListener("click", () => run(false));
  host.querySelector("#pptx-font-recheck")?.addEventListener("click", () => run(true));
}

/** 画左侧缩略图轨 + 中间当前页 + 该页的区域批注 */
async function paintPptxSlide(epoch) {
  const info = pptxState.info;
  const host = $("doc");
  const rail = $("pptx-rail");
  const stage = $("slide-canvas");
  if (!rail || !stage) return;

  // 头部：页数、缺字体/警告、重建按钮
  const head = $("pptx-head");
  const missing = pptxState.fontsChecked?.missing || [];
  if (head) {
    head.innerHTML = `
      <span class="pptx-count">共 ${pptxState.slides.length} 页 · 第 ${pptxState.page} 页</span>
      ${missing.length ? '<span class="pptx-flag">缺字体：' + escapeHtml(missing.join("、")) + '（预览可能失真）</span>' : ""}
      ${(info.warnings || []).length ? '<details class="pptx-warning"><summary>转换提示</summary><p>' + info.warnings.map(escapeHtml).join('<br>') + '</p></details>' : ""}
      ${pptxFontBanner({ ...info, fontsUsed: info.fontsUsed })}
      <button class="pptx-link" id="pptx-rebuild" title="文件被 Agent 改过后重建预览">重建预览</button>`;
    head.querySelector("#pptx-rebuild")?.addEventListener("click", async () => {
      const button = head.querySelector("#pptx-rebuild");
      button.disabled = true; button.textContent = "重建中…";
      const e = docEpoch;
      const next = await fetchPptxInfo(true);
      if (e !== docEpoch) return;
      if (next.status === "converting") {
        const done = await pptxAwaitJob(e);
        if (e === docEpoch && done) { pptxState.info = done; pptxState.url = done.pdfUrl || null; await renderPptx(host); }
      } else if (e === docEpoch) {
        await renderPptx(host);
      }
    });
    bindPptxFontCheck(head, info);
  }

  // 缩略图轨
  rail.innerHTML = "";
  for (const slide of pptxState.slides) {
    const thumb = document.createElement("button");
    thumb.className = "slide-thumb" + (slide.index === pptxState.page ? " active" : "");
    thumb.dataset.page = String(slide.index);
    thumb.innerHTML = `<span class="st-no">${slide.index}</span><span class="st-canvas"></span>`;
    const count = state.annotations.filter((a) => pptxLocate(a)?.page === slide.index).length;
    if (count) thumb.insertAdjacentHTML("beforeend", `<span class="st-badge">${count}</span>`);
    thumb.addEventListener("click", async () => {
      pptxState.page = slide.index;
      await paintPptxSlide(docEpoch);
    });
    rail.appendChild(thumb);
    if (window.renderPdfPage) {
      window.renderPdfPage(pptxState.url, slide.index, thumb.querySelector(".st-canvas"), { width: 168 })
        .catch(() => { thumb.classList.add("st-error"); });
    }
  }

  // 当前幻灯片
  if (!window.renderPdfPage) { stage.innerHTML = '<p class="pptx-note">渲染器尚未加载，请稍候再打开。</p>'; return; }
  const availableWidth = Math.max(180, Math.min(1100, $("pptx-stage").clientWidth));
  const size = await window.renderPdfPage(pptxState.url, pptxState.page, stage, { width: availableWidth });
  if (epoch !== docEpoch) return;
  const frame = $("slide-frame");
  if (frame) { frame.style.width = `${size.width}px`; frame.style.height = `${size.height}px`; }
  drawSlideRegions();
}

/** 当前页上的区域批注框；已完成的变灰，历史保留 */
function drawSlideRegions() {
  const layer = $("slide-regions");
  if (!layer) return;
  layer.innerHTML = "";
  let pending = 0;
  for (const annotation of state.annotations) {
    const located = pptxLocate(annotation);
    if (!located || located.page !== pptxState.page) continue;
    const region = annotation.region;
    const box = document.createElement("div");
    box.className = "region" + (annotation.status === "addressed" || feedbackGroup(annotation) === "history" ? " done" : "");
    box.dataset.ann = annotation.id;
    box.style.left = `${region.x * 100}%`;
    box.style.top = `${region.y * 100}%`;
    box.style.width = `${region.w * 100}%`;
    box.style.height = `${region.h * 100}%`;
    box.title = `${annotation.body || "（无意见）"}${located.movedFrom ? ` · 原第 ${located.movedFrom} 页` : ""}${located.legacy ? " · 仅页码绑定（不可靠）" : ""}`;
    const no = document.createElement("span");
    no.className = "region-no";
    no.textContent = displayNo(annotation);
    box.appendChild(no);
    box.addEventListener("click", (event) => { event.stopPropagation(); state.selected = annotation.id; renderCards(); drawLines(); });
    layer.appendChild(box);
    if (feedbackGroup(annotation) === "pending") pending += 1;
  }
  const frame = $("slide-frame");
  const orphans = state.annotations.filter((a) => pptxLocate(a)?.missing).length;
  if (frame) {
    frame.dataset.pending = String(pending);
    frame.dataset.orphans = String(orphans);
    if (orphans) {
      const flag = document.createElement("div");
      flag.className = "slide-orphan";
      flag.textContent = `有 ${orphans} 条批注找不到对应幻灯片（可能被删除）——已在右栏标为「待定位」`;
      frame.appendChild(flag);
    }
  }
}

/* 幻灯片框选：与 PDF 区域同一套交互，但锚点带上 slideId */
function startSlideRegionDraft(event) {
  const frame = event.target.closest("#slide-frame");
  if (!frame) return;
  event.preventDefault();
  const frameRect = frame.getBoundingClientRect();
  const startX = event.clientX;
  const startY = event.clientY;
  const draft = document.createElement("div");
  draft.className = "region-draft";
  frame.appendChild(draft);
  const move = (moveEvent) => {
    const x1 = Math.max(frameRect.left, Math.min(startX, moveEvent.clientX)) - frameRect.left;
    const y1 = Math.max(frameRect.top, Math.min(startY, moveEvent.clientY)) - frameRect.top;
    const x2 = Math.min(frameRect.right, Math.max(startX, moveEvent.clientX)) - frameRect.left;
    const y2 = Math.min(frameRect.bottom, Math.max(startY, moveEvent.clientY)) - frameRect.top;
    draft.style.left = `${x1}px`; draft.style.top = `${y1}px`;
    draft.style.width = `${x2 - x1}px`; draft.style.height = `${y2 - y1}px`;
  };
  const up = (upEvent) => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    draft.remove();
    const rx1 = Math.max(frameRect.left, Math.min(startX, upEvent.clientX));
    const ry1 = Math.max(frameRect.top, Math.min(startY, upEvent.clientY));
    const rx2 = Math.min(frameRect.right, Math.max(startX, upEvent.clientX));
    const ry2 = Math.min(frameRect.bottom, Math.max(startY, upEvent.clientY));
    const w = rx2 - rx1;
    const h = ry2 - ry1;
    if (w < 12 || h < 12) return;
    const page = pptxState.page;
    const slideId = pptxSlideIdOf(page);
    const region = {
      page, // 仅供显示/回退；真正的锚是 slideId
      slideId,
      x: (rx1 - frameRect.left) / frameRect.width,
      y: (ry1 - frameRect.top) / frameRect.height,
      w: w / frameRect.width,
      h: h / frameRect.height,
    };
    pending = {
      kind: "region",
      quote: `第 ${page} 页（幻灯片 ${slideId || "未知"}）区域 (${region.x.toFixed(2)}, ${region.y.toFixed(2)})`,
      prefix: "", suffix: "", region,
      worldY: toWorld(rx1 + w / 2, ry1 + h / 2).y,
    };
    const composer = $("composer");
    composer.hidden = false;
    composer.style.top = `${Math.min(upEvent.clientY + 12, window.innerHeight - 220)}px`;
    composer.style.left = `${Math.min(upEvent.clientX, window.innerWidth - 360)}px`;
    $("composer-quote").textContent = `框选第 ${page} 页区域 · 宽 ${Math.round(region.w * 100)}% × 高 ${Math.round(region.h * 100)}%`;
    $("composer-input").focus();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/* 幻灯片上直接框选：不需要先切「区域工具」，也不进无限画布（PPT 默认就是翻页阅读） */
$("doc").addEventListener("mousedown", (event) => {
  if (event.button !== 0 || state.mode !== "pptx") return;
  if (event.target.closest(".region")) return; // 点已有批注框是选中，不是画新框
  if (event.target.closest("#slide-frame")) startSlideRegionDraft(event);
});

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
      host.innerHTML = `<p style="color:#d64545">PDF 渲染失败：${String(err && err.message || err)}</p>`;
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
      host.innerHTML = `<p style="color:#d64545">Word 解析失败：${String(err && err.message || err)}</p>`;
    }
    return;
  }
  if (state.mode === "pptx") {
    await renderPptx(host);
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
          // HTML 是网页：宽度跟随容器自适应（响应式），高度按内容——不按内容撑宽
        };
        resize();
        if (window.ResizeObserver && frame.contentDocument && frame.contentDocument.body) {
          const observer = new ResizeObserver(resize);
          observer.observe(frame.contentDocument.body);
          frame.__coeditorObserver = observer;
        }
        bindHtmlSelection(frame);
        bindPeek(frame.contentDocument); // iframe 文档每次导航都是新的，逐次绑定
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

/* rerender=false：只刷新批注数据与卡片（批注增删改后用），不重建整份文档——
   否则改一条批注就要重开 PDF/重建 iframe，打断选择、跳位置、放大卡顿。 */
async function loadAnnotations({ rerender = true } = {}) {
  if (!state.path) return;
  const epoch = docEpoch;
  const [res, roundRes] = await Promise.all([
    checkedFetch(`/api/annotations?p=${encodeURIComponent(state.path)}`),
    checkedFetch(`/api/rounds?p=${encodeURIComponent(state.path)}`),
  ]);
  if (epoch !== docEpoch) return;
  const data = await res.json();
  state.annotations = data.annotations || [];
  state.revision = data.revision || 0;
  if (roundRes.ok) state.round = (await roundRes.json()).activeRound ?? 0;
  if (!rerender) {
    // 增量刷新：先解包旧锚点（保留文本），否则删除/取消的批注高亮会残留在文档上
    const roots = [$("doc")];
    try { const f = $("html-frame"); if (f && f.contentDocument && f.contentDocument.body) roots.push(f.contentDocument.body); } catch {}
    for (const root of roots) {
      if (!root) continue;
      root.querySelectorAll(".anchor").forEach(mark => {
        const parent = mark.parentNode;
        if (!parent) return;
        while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
        mark.remove();
      });
      if (root.normalize) root.normalize();
    }
  }
  if (rerender) await renderDocument();
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
  extractOutline();
  updatePaperWidth();
  renderCards();
  applyTransform();
  // §1 空侧栏默认关：没有批注的文档不占 300px；用户主动打开的选择在会话内被尊重
  if (!state.annotations.length && !state.userOpenedCards) {
    document.body.classList.add("cards-hidden");
    $("btn-cards").setAttribute("aria-pressed", "true");
  } else if (state.annotations.length && !localStorage.getItem("coeditor.cardsHidden")) {
    document.body.classList.remove("cards-hidden");
    $("btn-cards").setAttribute("aria-pressed", "false");
  }
  // 版本数轻量预取：让「版本对照」Tab 一开始就显示真实数量，而不是打开过后才正确
  const prefetchEpoch = epoch;
  fetch(`/api/versions?p=${encodeURIComponent(state.path)}`)
    .then(r => r.json())
    .then(d => {
      if (prefetchEpoch !== docEpoch) return; // 已切走：旧文档的版本列表不得覆盖当前面板
      versionState.list = d.versions || [];
      const tab = document.querySelector('[data-feedback="versions"] b');
      if (tab) tab.textContent = versionState.list.length;
    })
    .catch(() => {});
  drawArrows();
  renderNotes();
  renderImages();
  renderDrafts();
  reportUiState();
  if (floatCard && !state.annotations.some(e => e.id === floatCard.annId)) closeAnchorCard();
  // 图片/PDF 的区域线在增量刷新后也要重画（全量路径由 renderDocument 覆盖）
  drawLines();
  if (!$('drawer').hidden) renderDrawer();
  if (decayed > 0) toast(decayed + ' 条反馈暂时找不到原文，要求已保留，请检查定位');
}

/* 文档会话身份：每次 openDoc 递增。所有异步写入全局状态的地方都必须核对自己
   拿到的 epoch——A 文档的迟到响应不得写进 B 文档的正文、批注或版本列表。 */
async function openDoc(path, { push = true } = {}) {
  if (!canLeaveEditor()) return;
  if (editSession) leaveEditUi();
  feedbackFilter = 'pending';
  const epoch = ++docEpoch;
  state.path = path;
  state.mode = kindOf(path);
  // S1：旧画布偏好不再让文档自动进入空间总览——默认正常阅读（画布坐标数据保留）
  if (state.workspaceMode !== "read") state.workspaceMode = "read";
  syncWorkspaceModeUi();
  if (push) history.pushState({ doc: path }, "", `?doc=${encodeURIComponent(path)}`);
  const response = await fetch(`/api/doc?p=${encodeURIComponent(path)}`);
  if (epoch !== docEpoch) return; // 用户已切走：这次响应整体作废
  if (response.ok) {
    const data = await response.json();
    state.text = data.text;
    state.mtime = data.mtime;
  } else {
    state.text = "";
    state.mtime = 0;
  }
  $("docpath").textContent = path;
  // 阅读时长估算（文本类文档；中文约 400 字/分钟，HTML 按剥标签后正文计）
  if (state.mode === "text") {
    const plain = /\.html?$/i.test(path) ? String(state.text || "").replace(/<[^>]+>/g, " ") : String(state.text || "");
    const minutes = Math.max(1, Math.round(plain.replace(/\s/g, "").length / 400));
    $("docpath").textContent = `${path} · 约 ${minutes} 分钟`;
  }
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
    const extension = node.name.match(/\.[^.]+$/)?.[0] || '';
    const stem = extension ? node.name.slice(0, -extension.length) : node.name;
    return `<button class="tree-row file" type="button" data-path="${escapeAttr(node.path)}" title="${escapeAttr(node.path)}" style="--depth:${depth}"><i style="background:${dot[node.kind] || dot.text}"></i><span class="tree-name">${escapeHtml(stem)}</span><span class="tree-ext">${escapeHtml(extension)}</span></button>`;
  }).join("");
  $('tree').innerHTML = render(data.tree, 0);
  filterFiles();
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

function filterFiles() {
 const query = ($('file-search').value || '').trim().toLocaleLowerCase();
 for (const file of $('tree').querySelectorAll('.file')) file.hidden = Boolean(query) && !file.dataset.path.toLocaleLowerCase().includes(query);
 for (const dir of [...$('tree').querySelectorAll('.tree-node')].reverse()) {
  dir.hidden = Boolean(query) && ![...dir.querySelectorAll('.file')].some(f => !f.hidden);
  dir.classList.toggle('search-open', Boolean(query));
 }
}
$('file-search').addEventListener('input', filterFiles);
$('btn-recent').addEventListener('click', async () => { $('fs-modal').hidden = false; await fsLoadRecent(); await fsLoad(state.vaultRoot); });
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

/** 建批注时随身的精确定位字段（服务端白名单放行，见 server.mjs） */
function anchorPayload(source) {
  const p = source || pending || {};
  return {
    ...(Number.isFinite(p.pageIndex) ? { pageIndex: p.pageIndex } : {}),
    ...(Number.isFinite(p.textOffset) ? { textOffset: p.textOffset } : {}),
    ...(Number.isFinite(p.textLen) ? { textLen: p.textLen } : {}),
    ...(typeof p.pageFp === "string" && p.pageFp ? { pageFp: p.pageFp } : {}),
  };
}

/** 把 range 裁进 root；起点不在正文内时返回 null（= 这次拖选不算正文选区）。
 *
 *  只裁尾巴、绝不裁头。为什么：起点在正文之外时（例如从顶栏或页边空白按下去往正文里拖），
 *  若把起点补成「文档开头」，就会把整段文档吞成一条批注——实测过，这是比"没有批注"更坏的结果。
 *  终点在正文之外（从正文里往外拖）则是合理意图，夹到文档末尾即可。 */
function clampRangeToRoot(root, range) {
  const inside = (node) => Boolean(node) && (node === root || root.contains(node));
  if (!inside(range.startContainer)) return null;
  const out = range.cloneRange();
  if (!inside(out.endContainer)) out.setEnd(root, root.childNodes.length);
  return out.collapsed ? null : out;
}

/** 节点所属的 .pdf-page（没有则 null） */
function pageOfNode(node) {
  if (!node) return null;
  const el = node.nodeType === 1 ? node : node.parentElement;
  return el && el.closest ? el.closest(".pdf-page") : null;
}

/** 从 root 起算，(node, offset) 在原文里的字符偏移；不在 root 内返回 -1 */
function offsetWithin(root, node, offset) {
  if (!node) return -1;
  const owner = root.ownerDocument || document;
  if (node.nodeType !== 3) return -1; // 选区落在元素上（罕见）就不做精确偏移，交给搜索兜底
  const walker = owner.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let total = 0;
  let current;
  while ((current = walker.nextNode())) {
    if (current === node) return total + Math.min(offset, current.nodeValue.length);
    total += current.nodeValue.length;
  }
  return -1;
}

function captureTextSelection(root, selection, rectOffset = { left: 0, top: 0 }) {
  if (state.mode === "image") return; // 图片走区域框选，不参与文字选区
  if (state.canvasTool === "region") return; // 区域工具拖框中：不触发文字浮条（且不 stopPropagation 挡掉 region 的 mouseup 监听）
  if (document.body.classList.contains("editing-doc")) return; // 编辑态由 textarea 自己处理
  if (!selection || !selection.rangeCount) { hideSelMenu(); return; }
  /* 选区先与文档求交集再采信（A04 实测根因）：
     跨页拖选时浏览器可能把 anchor 放在顶栏（#docpath）而只把 focus 落在正文里，
     旧代码用 `root.contains(selection.anchorNode)` 一票否决，整个选区被丢掉——
     表现就是"跨页选完没有批注按钮"。改成取交集：文档外的部分裁掉，文档内的部分照常可用。 */
  const range = clampRangeToRoot(root, selection.getRangeAt(0));
  if (!range) { hideSelMenu(); return; } // 起点在正文之外：不当成正文选区，宁可不出批注按钮
  const text = String(range).trim();
  if (!text) { hideSelMenu(); return; }
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
  // 精确定位信息：页号 + 页内原始偏移 + 该页文本指纹。
  // 指纹一致时直接按偏移落点（零猜测）；内容变了指纹就对不上，自动退回规范化搜索。
  // 跨页选区按整篇建索引：按页搜会把跨页的 quote 切成两半，永远搜不到
  const startPage = pageOfNode(range.startContainer);
  const endPage = pageOfNode(range.endContainer);
  const pageEl = startPage && startPage === endPage ? endPage : null;
  const scopeRoot = pageEl || root;
  const startOffset = offsetWithin(scopeRoot, range.startContainer, range.startOffset);
  const endOffset = offsetWithin(scopeRoot, range.endContainer, range.endOffset);
  pending = {
    quote: text,
    prefix: String(before).slice(-40),
    suffix: String(after).slice(0, 40),
    worldY: toWorld(rect.left, rect.top).y,
    clientRect: rect,
    ...(pageEl && Number.isFinite(Number(pageEl.dataset.page)) ? { pageIndex: Number(pageEl.dataset.page) } : {}),
    ...(startOffset >= 0 && endOffset > startOffset ? { textOffset: startOffset, textLen: endOffset - startOffset } : {}),
    pageFp: textFingerprint(scopeRoot.textContent || ""),
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
  inner.addEventListener("click", (event) => {
    const mark = event.target.closest && event.target.closest(".anchor[data-ann]");
    if (!mark) return;
    const frameRect = frame.getBoundingClientRect();
    const r = mark.getBoundingClientRect();
    openAnchorCard(mark.dataset.ann, { x: (r.left + frameRect.left) / view.zoom, y: (r.top + frameRect.top) / view.zoom, w: r.width / view.zoom, h: r.height / view.zoom });
  });
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
  // 外链资源策略（F12）：预览不执行脚本、不跑 fetch、不嵌套框架，本地相对资源照常渲染；
  // 远程图片/样式可以显示，但策略是显式的——本地批注层不做匿名代理
  const csp = preview.createElement("meta");
  csp.setAttribute("http-equiv", "Content-Security-Policy");
  csp.setAttribute("content", "default-src 'none'; img-src http: https: data: blob:; style-src 'unsafe-inline' http: https:; font-src http: https: data:; media-src http: https: data: blob:; form-action 'none'");
  if (preview.head) preview.head.prepend(csp);
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
    .anchor[data-status="deprecated"]{opacity:.45}
    .anchor.coeditor-peek{outline:2px solid rgba(239,107,78,.6);outline-offset:1px;border-radius:3px}`;
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
  await checkedFetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind, quote: pending.quote, prefix: pending.prefix, suffix: pending.suffix,
      body: "", x: RAIL_X, y, round: state.round ?? 0, ...anchorPayload(pending),
    }),
  });
  const quote = pending.quote;
  pending = null;
  clearTextSelections();
  await loadAnnotations();
  // U04：保留/删除线建在对应分组（保留组/待处理组）——用户立刻能看到自己刚标的
  feedbackFilter = kind === "highlight" ? "retained" : "pending";
  renderCards();
  toast(kind === "highlight" ? `已保留「${quote.slice(0, 18)}…」` : `已标记删除线「${quote.slice(0, 18)}…」`);
});

function openComposer() {
  if (!pending) return;
  closeAnchorCard(); // 浮卡绝不与意见输入框并存遮字
  const composer = $("composer");
  const rect = pending.clientRect || (window.getSelection().rangeCount ? window.getSelection().getRangeAt(0).getBoundingClientRect() : { bottom: 200, left: 200 });
  composer.hidden = false;
  composer.style.top = `${Math.min(rect.bottom + 10, window.innerHeight - 220)}px`;
  composer.style.left = `${Math.min(rect.left, window.innerWidth - 360)}px`;
  $("composer-quote").textContent = `“${pending.quote.slice(0, 90)}”`;
  composerCreated = null;
  if (!composerStatusEl) {
    composerStatusEl = document.createElement("span");
    composerStatusEl.className = "edit-status";
    composerStatusEl.textContent = "自动保存";
    const tip = composer.querySelector(".c-tip");
    if (tip) tip.replaceWith(composerStatusEl); else composer.appendChild(composerStatusEl);
  }
  composerStatusEl.textContent = "自动保存";
  $("composer-input").focus();
}
// 输入 → 600ms 防抖自动保存；composition 期间不发
(() => {
  const input = $("composer-input");
  const schedule = () => {
    if (composerComposing) return;
    if (composerStatusEl) composerStatusEl.textContent = "输入中…";
    clearTimeout(composerTimer);
    composerTimer = setTimeout(() => flushComposer().catch(() => {}), 600);
  };
  input.addEventListener("compositionstart", () => { composerComposing = true; });
  input.addEventListener("compositionend", () => { composerComposing = false; schedule(); });
  input.addEventListener("input", schedule);
  input.addEventListener("blur", () => flushComposer().catch(() => {}));
})();

$("composer-cancel").addEventListener("click", closeComposer);

let composerTimer = null;
let composerComposing = false;
let composerCreated = null; // 自动创建后的批注（后续输入走 PATCH）
let composerStatusEl = null;
let composerFlushInFlight = null; // blur 与 click 会先后触发 flush——共享同一个 in-flight Promise，防止并发双创建
async function flushComposer() {
  clearTimeout(composerTimer);
  if (composerFlushInFlight) return composerFlushInFlight;
  composerFlushInFlight = runComposerFlush().finally(() => { composerFlushInFlight = null; });
  return composerFlushInFlight;
}
async function runComposerFlush() {
  const body = $("composer-input").value.trim();
  if (!body) return; // 空内容不产生待办
  if (composerCreated) {
    // 已创建：编辑走 PATCH（修订号由服务端递增）
    try {
      await patch(composerCreated.id, { body, event: "edited" });
      if (composerStatusEl) composerStatusEl.textContent = "已保存";
      setSaveState("clean");
    } catch (error) {
      if (composerStatusEl) composerStatusEl.textContent = "保存失败 · 请重试";
      setSaveState("error");
    }
    return;
  }
  if (!pending) return;
  try {
    const res = await fetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quote: pending.quote, prefix: pending.prefix, suffix: pending.suffix,
        body, x: RAIL_X, y: freeSpotNear(pending.worldY),
        kind: pending.kind || "text-quote", region: pending.region || null, image: pending.image || null,
        round: state.round ?? 0, ...anchorPayload(pending),
      }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "HTTP " + res.status);
    composerCreated = (await res.json()).annotation;
    if (composerStatusEl) composerStatusEl.textContent = "已保存";
    setSaveState("clean");
  } catch (error) {
    // 失败：输入保留在 composer，明确提示可重试
    if (composerStatusEl) composerStatusEl.textContent = "保存失败 · 请重试";
    setSaveState("error");
    toast("意见保存失败，内容仍保留：" + String(error?.message || error));
  }
}

function closeComposer() {
  clearTimeout(composerTimer);
  flushComposer().catch(() => {}); // 关闭前提交待保存内容（不得丢草稿）
  $("composer").hidden = true;
  $("composer-input").value = "";
  pending = null;
  composerCreated = null;
  clearTextSelections();
  // 刷新列表（自动创建的批注上屏）；不重渲染文档避免打断
  loadAnnotations({ rerender: false }).catch(() => {});
}

async function saveAnnotation() {
  const savedGroup = (pending && pending.kind) === "highlight" ? "retained" : "pending"; // closeComposer 清 pending，先记
  await flushComposer();
  closeComposer();
  await loadAnnotations({ rerender: false });
  if (feedbackFilter !== savedGroup) { feedbackFilter = savedGroup; renderCards(); }
  document.body.classList.remove("cards-hidden"); // 写意见后确保可见（不突然关闭）
  $("btn-cards").setAttribute("aria-pressed", "false");
  toast("批注已保存");
}

// 保存失败要落在用户眼前（composer 保持打开可重试），而不是变成全局「操作未完成」
const saveAnnotationSafe = () => saveAnnotation().catch(error => toast("保存失败：" + String(error?.message || error)));
$("composer-save").addEventListener("click", saveAnnotationSafe);
$("composer-input").addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") saveAnnotationSafe();
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
  const officeHelp = document.getElementById('office-help-button');
  if (officeHelp) officeHelp.hidden = state.mode !== 'pptx';
  const officeBtn = document.getElementById('office-edit-button');
  if (officeBtn) officeBtn.hidden = !['docx', 'pptx'].includes(state.mode);
  document.body.dataset.workspaceMode = state.workspaceMode;
  document.querySelectorAll("#workspace-modes [data-workspace-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.workspaceMode === state.workspaceMode);
  });
  // S1：不支持直接编辑的格式不显示"编辑"按钮（而不是显示但禁用）
  const editBtn = document.querySelector('#workspace-modes [data-workspace-mode="edit"]');
  if (editBtn) editBtn.hidden = !isEditableDocument();
  const canvasBtn = document.getElementById("btn-canvas-mode");
  if (canvasBtn) canvasBtn.textContent = isCanvasMode() ? "退出图片工作台" : "图片工作台（实验）";
  $("btn-fit").textContent = isCanvasMode() ? "显示全部" : "适合宽度";
  $("btn-layout").disabled = !isCanvasMode();
  $("btn-lines").disabled = !isCanvasMode();
  // PDF 列按钮只在 PDF 模式显示（已移入更多菜单）
  const colsBtn = document.getElementById("bar-pdf-cols");
  if (colsBtn) colsBtn.hidden = state.mode !== "pdf";
}

async function setWorkspaceMode(mode) {
  if (mode === "edit" && !isEditableDocument()) {
    toast("这种格式目前只读；Markdown、HTML、TXT、JSON、CSV 可以直接编辑");
    return;
  }
  if (mode === state.workspaceMode && (mode !== "edit" || editSession)) return;
  if (editSession && mode !== 'edit') {
    if (!canLeaveEditor()) return;
    leaveEditUi();
    const data = await (await checkedFetch('/api/doc?p=' + encodeURIComponent(state.path))).json();
    state.text = data.text; state.mtime = data.mtime;
  }
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
  editSession = { cm, baseMtime: state.mtime, originalText: state.text };
  cm.on('change', () => syncStatus(hasDraft() ? '文字未保存 · ⌘S 保存' : '已保存到本地'));
}

async function saveEdit() {
  if (!editSession) return;
  const epoch = docEpoch;
  const submittedText = editSession.cm.getValue(); // 提交的是此刻的文本；期间的新输入属于下一次保存
  syncStatus("正在保存…");
  const res = await fetch(`/api/write?p=${encodeURIComponent(state.path)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: submittedText, baseMtime: editSession.baseMtime }),
  });
  if (epoch !== docEpoch) { toast("已保存原文件 · 你已切换到其他文档"); return; }
  if (res.status === 409) {
    toast("文件已被外部修改，请「返回阅读」后重新进入编辑");
    syncStatus('保存冲突 · 草稿仍保留', true);
    // Do not adopt the external mtime without loading/merging its new source.
    return;
  }
  if (!res.ok) { toast("保存失败： " + (await res.json().catch(() => ({}))).error); syncStatus("未保存 · 请重试", true); return; }
  const data = await res.json();
  state.mtime = data.mtime;
  editSession.baseMtime = data.mtime; // 提交成功后以新 mtime 为基准，继续输入再保存不会被误判冲突
  if (editSession.cm.getValue() !== submittedText) {
    // 保存请求在飞行中时用户又打了字：盘上是提交的版本，编辑器里还有新草稿——不能宣布全部已保存
    state.text = submittedText;
    setSaveState("dirty");
    toast("已保存 · 保存期间还有新输入，再按 ⌘S 提交剩余修改");
    return;
  }
  state.text = submittedText; // 同步内存文本，loadAnnotations 重渲染才用新内容
  syncStatus("已保存到本地");
  toast("已保存，批注正在重新锚定");
  // v13：手动修改保留句 → 提示确认并允许「修改并更新保留内容」或「解除保留」，
  // 旧修订入 history 追溯。不自动解除、不自动改指。
  const lostRetained = state.annotations.filter(a => a.kind === "highlight" && a.status === "active" && !submittedText.includes(a.quote));
  if (lostRetained.length) {
    const actOn = (mutate) => async () => {
      for (const item of lostRetained) await mutate(item);
      await loadAnnotations({ rerender: false });
      toast("保留要求已更新");
    };
    // 更新指向：prefix 能在新文本定位时，取其后的行作为新 quote；找不到只能解除
    setTimeout(() => toast(`检测到 ${lostRetained.length} 处保留句被修改——如何处理？`, [
      { label: "更新保留指向", fn: actOn(async (item) => {
          let newQuote = null;
          if (item.prefix) {
            const at = submittedText.indexOf(item.prefix);
            if (at >= 0) {
              const lineStart = submittedText.indexOf("\n", at) + 1 || at + item.prefix.length;
              const lineEnd = submittedText.indexOf("\n", lineStart);
              newQuote = submittedText.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 80);
            }
          }
          if (!newQuote) { // 定位不到新位置：解除并如实说明
            await patch(item.id, { status: "deprecated", event: "released-after-edit", weight: 0 });
            return;
          }
          await patch(item.id, { quote: newQuote, event: "retargeted-after-edit" });
        }) },
      { label: "解除保留", fn: actOn(async (item) => { await patch(item.id, { status: "deprecated", event: "released-after-edit", weight: 0 }); }) },
    ]), 400);
  }
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

/* B03：触控板缩放。
   旧实现是 `deltaY < 0 ? 1.1 : 1/1.1` —— 每个 wheel 事件当作一个固定倍率按钮，
   忽略手势幅度与 deltaMode。触控板一次轻捏会连发几十个事件，于是轻微动作也跳档。
   现在：deltaMode 归一化 → 帧内合并 → 连续指数映射，倍率随手势量平滑变化。 */
let wheelZoomAccum = 0;
let wheelZoomFrame = 0;
let wheelZoomPoint = { x: 0, y: 0 };
const WHEEL_ZOOM_SENSITIVITY = 0.0022; // exp 系数：约每 100px 手势 ≈ 1.25 倍
const WHEEL_ZOOM_MAX_STEP = 0.18; // 单帧最大倍率变化，封住「一帧跳档」

function flushWheelZoom() {
  wheelZoomFrame = 0;
  const dy = Math.max(-140, Math.min(140, wheelZoomAccum)); // 一帧内累计也要封顶
  wheelZoomAccum = 0;
  if (!dy) return;
  const factor = Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY);
  zoomAt(Math.min(1 + WHEEL_ZOOM_MAX_STEP, Math.max(1 - WHEEL_ZOOM_MAX_STEP, factor)), wheelZoomPoint.x, wheelZoomPoint.y);
}

$("viewport").addEventListener("wheel", (event) => {
  const zoomGesture = event.ctrlKey || event.metaKey;
  // 普通双指滚动：阅读态交给原生滚动（不抢），画布态才平移视野
  if (!zoomGesture) {
    if (!isCanvasMode()) return;
    event.preventDefault();
    view.panX -= event.deltaX;
    view.panY -= event.deltaY;
    applyTransform();
    return;
  }
  event.preventDefault();
  // deltaMode 归一化：0=像素 1=行 2=页（不归一化时鼠标滚轮一格会被当成 1px 手势）
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? $("viewport").clientHeight : 1;
  wheelZoomAccum += event.deltaY * unit;
  wheelZoomPoint = { x: event.clientX, y: event.clientY };
  if (!wheelZoomFrame) wheelZoomFrame = requestAnimationFrame(flushWheelZoom);
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
/* 右侧反馈栏可折叠：阅读的主体责任是文字本身；隐藏后批注走顶栏「批注」抽屉 */
/* U04 单一反馈入口：宽屏切换右侧反馈栏，窄屏切换抽屉（同一个面板的两种形态） */
function toggleFeedbackPanel() {
  state.userOpenedCards = true; // 用户主动操作后，自动开关不再覆盖其选择
  if (window.innerWidth <= 1180 && !isCanvasMode()) {
    renderDrawer();
    $("drawer").hidden = !$("drawer").hidden;
    $("btn-cards").setAttribute("aria-pressed", $("drawer").hidden ? "false" : "true");
    return;
  }
  const hidden = document.body.classList.toggle("cards-hidden");
  $("btn-cards").setAttribute("aria-pressed", String(hidden));
  try { localStorage.setItem("coeditor.cardsHidden", hidden ? "1" : "0"); } catch {}
  if (!isCanvasMode()) { updatePaperWidth(); if (state.fitFollow) fitReadWidth(); }
}
$("btn-cards").addEventListener("click", toggleFeedbackPanel);
$("cards-collapse").addEventListener("click", () => toggleFeedbackPanel()); // §1 头部明确收起钮
$("btn-canvas-mode").addEventListener("click", () => {
  setWorkspaceMode(isCanvasMode() ? "read" : "canvas");
});
try { if (localStorage.getItem("coeditor.cardsHidden") === "1") { document.body.classList.add("cards-hidden"); $("btn-cards").setAttribute("aria-pressed", "true"); } } catch {}
$("btn-drawer").hidden = true; // U04：入口合并进「反馈」，按钮保留供旧脚本兼容
// 反馈栏拖拽调宽（规格 §3.2：240–400，默认 300），记忆在本地
const CARDS_MIN = 240, CARDS_MAX = 400, CARDS_COLLAPSE_BELOW = 200;
(() => {
  const saved = Number(localStorage.getItem("coeditor.cardsWidth"));
  if (Number.isFinite(saved) && saved >= CARDS_MIN && saved <= CARDS_MAX) document.documentElement.style.setProperty("--cards-w", `${saved}px`);
})();
$("cards-resizer").addEventListener("pointerdown", (event) => {
  event.preventDefault();
  $("cards-resizer").setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-cards");
  const move = (moveEvent) => {
    // §1：按工作区右边界计算，不用 window.innerWidth（rail 宽/隐藏会影响）
    const mainRight = $("main").getBoundingClientRect().right;
    const raw = mainRight - moveEvent.clientX;
    // 收起判定用「指针原始位置」，宽度夹紧用 240–400：
    // 旧代码把夹紧下限写成收起阈值(200)，于是能拖到 200–240 这段规格外宽度
    const width = Math.min(CARDS_MAX, Math.max(CARDS_MIN, raw));
    if (raw <= CARDS_COLLAPSE_BELOW) { // 拖过阈值 = 意图收起
      document.documentElement.style.setProperty("--cards-w", `${CARDS_MIN}px`);
      document.body.classList.add("cards-hidden");
      $("btn-cards").setAttribute("aria-pressed", "true");
      try { localStorage.setItem("coeditor.cardsHidden", "1"); } catch {}
      return;
    }
    document.body.classList.remove("cards-hidden");
    $("btn-cards").setAttribute("aria-pressed", "false");
    document.documentElement.style.setProperty("--cards-w", `${width}px`);
  };
  const finish = () => {
    $("cards-resizer").removeEventListener("pointermove", move);
    $("cards-resizer").removeEventListener("pointerup", finish);
    $("cards-resizer").removeEventListener("pointercancel", finish);
    document.body.classList.remove("resizing-cards");
    if (!document.body.classList.contains("cards-hidden")) {
      const width = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--cards-w")) || 300;
      localStorage.setItem("coeditor.cardsWidth", String(width));
    }
    updatePaperWidth();
  };
  $("cards-resizer").addEventListener("pointermove", move);
  $("cards-resizer").addEventListener("pointerup", finish);
  $("cards-resizer").addEventListener("pointercancel", finish);
  $("cards-resizer").addEventListener("lostpointercapture", finish, { once: true });
});
// §1 键盘调节：分隔柄可聚焦，←→ 调宽，Enter 收起/展开
$("cards-resizer").setAttribute("tabindex", "0");
$("cards-resizer").setAttribute("role", "separator");
$("cards-resizer").setAttribute("aria-label", "调整反馈栏宽度（左右箭头调节，回车收起/展开）");
$("cards-resizer").addEventListener("keydown", (event) => {
  const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--cards-w")) || 300;
  if (event.key === "ArrowLeft") { document.documentElement.style.setProperty("--cards-w", `${Math.min(CARDS_MAX, cur + 16)}px`); event.preventDefault(); }
  else if (event.key === "ArrowRight") { document.documentElement.style.setProperty("--cards-w", `${Math.max(CARDS_MIN, cur - 16)}px`); event.preventDefault(); }
  else if (event.key === "Enter") { toggleFeedbackPanel(); event.preventDefault(); }
});
/* 点缩放百分比回到 100%（浏览器习惯） */
$("zoom").addEventListener("click", () => { if (!isCanvasMode()) { view.zoom = 1; applyTransform(); } });
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
  railAutoCollapsed = false; // 用户自己动过，就不再替他自动展开
  setTimeout(applyTransform, 240);
});

/* 规格 §3.2：窄于 1100px 先折叠文件树；宽回来时只在「是系统自动收的」情况下自动展开。
   全屏手动收起不会被窗口一宽一窄来回翻开。 */
const NARROW_BREAK = 1100;
let railAutoCollapsed = false;
function applyNarrowLayout() {
  const narrow = window.innerWidth < NARROW_BREAK;
  const hidden = document.body.classList.contains("rail-hidden");
  if (narrow && !hidden) {
    railAutoCollapsed = true;
    document.body.classList.add("rail-hidden");
    setTimeout(applyTransform, 240);
  } else if (!narrow && hidden && railAutoCollapsed) {
    railAutoCollapsed = false;
    document.body.classList.remove("rail-hidden");
    setTimeout(applyTransform, 240);
  }
}
window.addEventListener("resize", applyNarrowLayout);
applyNarrowLayout();

/* 侧栏像编辑器一样可拖动，宽度只保存在本机浏览器。 */
// 规格 §3.2：文件树 180–320（默认 224），批注栏 240–400（默认 300）
const RAIL_MIN = 180, RAIL_MAX = 320;
const savedRailWidth = Number(localStorage.getItem("coeditor.railWidth"));
if (Number.isFinite(savedRailWidth)) {
  document.documentElement.style.setProperty("--rail-width", `${Math.min(RAIL_MAX, Math.max(RAIL_MIN, savedRailWidth))}px`);
}
$("rail-resizer").addEventListener("pointerdown", (event) => {
  if (document.body.classList.contains("rail-hidden")) return;
  event.preventDefault();
  $("rail-resizer").setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-rail");
  const move = (moveEvent) => {
    const width = Math.min(RAIL_MAX, Math.max(RAIL_MIN, moveEvent.clientX));
    document.documentElement.style.setProperty("--rail-width", `${width}px`);
    localStorage.setItem("coeditor.railWidth", String(Math.round(width)));
    applyTransform();
  };
  const up = () => {
    $("rail-resizer").removeEventListener("pointermove", move);
    $("rail-resizer").removeEventListener("pointerup", up);
    $("rail-resizer").removeEventListener("pointercancel", up);
    document.body.classList.remove("resizing-rail");
    clearTimeout(railFitTimer);
    railFitTimer = setTimeout(() => { if (!isCanvasMode()) updatePaperWidth(); }, 180);
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
  // U07：每条约束 = 一句自包含任务卡（位置 + 引用 + 意见 + 动作），与 MCP brief 同一生成逻辑
  const where = (item) => item.region && Number.isFinite(item.region.page) ? `第 ${item.region.page} 页` : "文中";
  const annLine = (item) => {
    const q = (item.quote || "").trim();
    const ref = q ? `「${q.length > 60 ? q.slice(0, 60) + "…" : q}」` : "";
    const opinion = (item.body || "").trim();
    if (item.kind === "highlight") {
      return `- [${noOf(item)}·保留] ${where(item)}：${ref} 这段必须原样保留——不删除、不改写、不移动${opinion ? `。用户说明：${opinion}` : ""}`;
    }
    if (item.kind === "strike") {
      return `- [${noOf(item)}·删除线] ${where(item)}：${ref} 删除或按新表述重写${opinion ? `。用户意见：${opinion}` : ""}`;
    }
    if (item.kind === "region") {
      return `- [${noOf(item)}·区域] ${where(item)}：用户框选了一块区域。意见：${opinion || "（未填写，请结合页面内容理解）"}`;
    }
    return [
      `- [${noOf(item)}] ${where(item)}：针对 ${ref || "该处内容"}，用户要求：${opinion || "（未填写具体意见，请阅读上下文判断合理修改）"}`,
      ...(item.conflicts_with || []).length ? [`  ⚠ 与 ${item.conflicts_with.map(noOf).join("/")} 冲突，未经裁定前先询问用户`] : [],
    ];
  };
  const lines = [
    `# ${state.path} · 修改要求与保留要求`,
    "",
    `两条铁律：① 最小改动——除下列条目外，其余内容保持原样，不擅自润色、改数字、删引用、换结构；② 「保留」条目持续有效直到用户取消，冲突时先暂停询问。`,
    `完成后逐条报告完成情况（部分完成只报部分）。`,
    "",
    `## 待修改 · ${current.length} 条`,
    "",
    ...current.flatMap(annLine),
  ];
  if (older.length) {
    lines.push("", `## 更早的意见（仍有效）· ${older.length} 条`, "");
    lines.push(...older.flatMap(annLine));
  }
  const retainedNow = state.annotations.filter((item) => item.kind === "highlight" && item.status === "active");
  if (retainedNow.length) {
    lines.push("", `## 保留要求（持续有效 · 不得改写删除）· ${retainedNow.length} 条`, "");
    lines.push(...retainedNow.flatMap(annLine));
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
  const all = state.annotations.filter(a => feedbackGroup(a) === feedbackFilter).sort((a, b) => roundOf(b) - roundOf(a) || (b.weight - a.weight));
  const groups = new Map();
  for (const item of all) {
    const r = roundOf(item);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(item);
  }
  const itemHtml = (item) => `
    <div class="d-item" data-id="${item.id}" data-status="${item.status}">
      <div class="d-item-head">
        ${item.kind === "highlight" ? '<span class="c-kind hl">保留</span>' : item.kind === "strike" ? '<span class="c-kind st">删除线</span>' : ""}
        ${item.kind === "highlight" && (item.anchorStatus === "missing" || item.status === "stale") ? '<span class="c-badge" style="color:#8a6116">待定位</span>' : item.anchorStatus === "missing" ? '<span class="c-badge" style="color:#8a6116">缺失待确认</span>' : ""}
        ${item.status === "active" ? '<i class="live-dot" title="当前使用"></i>' : `<span class="c-badge">${LABELS[item.status] || item.status}</span>`}

      </div>
      ${item.body ? `<div class="d-item-body">${escapeHtml(item.body)}</div>` : ""}
      <div class="d-item-quote">「${escapeHtml(item.quote.slice(0, 50))}」</div>
      <div class="d-actions">
        ${item.kind === "highlight" ? "" : '<button data-d-act="edit">编辑</button>'}
        <button data-d-act="delete" class="danger">${item.kind === "highlight" ? "取消保留" : "删除"}</button>
      </div>
    </div>`;
  let html = feedbackTabs();
  // 窄屏抽屉与宽屏侧栏是同一个功能的两个入口：版本面板直接复用同一组件，不另养一套
  if (feedbackFilter === 'versions') {
    $("drawer-body").innerHTML = html + '<div class="version-panel drawer-versions"></div>';
    renderVersions($("drawer-body").querySelector('.drawer-versions'));
    return;
  }
  for (const [r, items] of groups) {
    html += `<div class="d-round">${r === round ? `当前意见` : `更早的意见`}</div>`;
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
    const res = await checkedFetch(`/api/annotations?p=${encodeURIComponent(state.path)}`, {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: item.id }),
    });
    if (!res.ok) return toast("删除失败，批注未改变");
    await loadAnnotations({ rerender: false });
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
function toast(message, actions) {
  // actions: 单函数（=「撤销」）或 [{label, fn}] 数组（多动作，如保留句更新选择）
  const list = typeof actions === "function" ? [{ label: "撤销", fn: actions }] : actions || [];
  const node = $("toast");
  node.textContent = message;
  node.querySelectorAll(".toast-action").forEach(n => n.remove());
  for (const { label, fn } of list) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = label;
    btn.addEventListener("click", () => { clearTimeout(toastTimer); node.classList.remove("show"); fn(); });
    node.appendChild(btn);
  }
  node.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove("show"), list.length ? 10000 : 2600);
}

/* ---------------- 批次：只有人明确点击才推进，文件 mtime 变化不替人做产品判断 ---------------- */
$("btn-round").addEventListener("click", async () => {
  const res = await fetch(`/api/rounds?p=${encodeURIComponent(state.path)}`, {
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

async function fsLoadRecent() {
  const wrap = $("fs-recent-wrap");
  const host = $("fs-recent");
  const res = await fetch("/api/recent-vaults").catch(() => null);
  const data = res && res.ok ? await res.json() : null;
  const list = (data && data.vaults) || [];
  wrap.hidden = list.length === 0;
  host.innerHTML = list.map((entry) => {
    const name = entry.path.split("/").filter(Boolean).pop() || entry.path;
    const home = entry.path.startsWith("/Users/") || entry.path.startsWith("/home/") ? entry.path.replace(/^\/(Users|home)\/[^/]+/, "~") : entry.path;
    return `<button class="fs-recent-item${entry.current ? " cur" : ""}" data-fs-path="${escapeHtml(entry.path)}" title="${escapeHtml(entry.path)}">${escapeHtml(name)}<em>${escapeHtml(home)}</em>${entry.current ? '<i class="fs-dot" title="当前"></i>' : ""}</button>`;
  }).join("");
}

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
  if (!canLeaveEditor()) return false;
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
    await fsLoadRecent();
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
// 最近打开：直接切换 vault（不再进目录浏览），与快速跳转分开
$("fs-recent").addEventListener("click", async (event) => {
  const target = event.target.closest("[data-fs-path]");
  if (!target) return;
  if (target.classList.contains("cur")) { $("fs-modal").hidden = true; return; } // 已是当前目录
  await switchVault(target.dataset.fsPath);
  await fsLoadRecent();
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

let railFitTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(railFitTimer);
  railFitTimer = setTimeout(() => {
    if (isCanvasMode()) return;
    if (state.mode === "pdf") { schedulePdfRebuild(); return; } // 容器宽/DPR 变化：fitScale 要重算，只能完整重建
    updatePaperWidth(); // 流式文档 100% 恒适配可用宽；zoom 因子保持
  }, 200);
});
// 跨屏拖动时 devicePixelRatio 变化不触发 resize：单独监听并重挂
function watchDprChange() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
  mq.addEventListener("change", () => {
    if (state.mode === "pdf" && !isCanvasMode()) schedulePdfRebuild();
    watchDprChange();
  }, { once: true });
}
watchDprChange();

let polling = false;
setInterval(async () => {
 if (!state.path || polling) return;
 polling = true;
 try {
  const path = state.path;
  const info = await (await checkedFetch('/api/sync?p=' + encodeURIComponent(path))).json();
  if (path !== state.path) return;
  if (info.root !== state.vaultRoot) {
   if (editSession) { syncStatus('目录已切换 · 请先复制保存当前草稿', true); return; }
   await resetDocView(); await loadTree(); toast('目录已在别处切换，请重新选择文档'); return;
  }
  if (editSession || !$('html-edit').hidden || document.querySelector('.card-edit, .d-edit')) {
   if (info.mtime !== state.mtime) syncStatus('文件在外部更新 · 当前草稿未被覆盖', true);
   return;
  }
  const changed = info.mtime !== state.mtime;
  if (changed) {
   const data = await (await checkedFetch('/api/doc?p=' + encodeURIComponent(path))).json();
   if (path !== state.path) return;
   state.text = data.text; state.mtime = data.mtime;
  }
  if (changed || info.revision !== state.revision) {
   await loadCanvas(); await loadAnnotations(); syncStatus('已同步 · 本地保存');
  }
 } catch (error) { syncStatus('连接中断 · 请检查本地服务', true); }
 finally { polling = false; }
}, 2000);

window.addEventListener("resize", applyTransform);
window.addEventListener("popstate", (event) => {
  const path = (event.state && event.state.doc) || new URLSearchParams(location.search).get("doc");
  if (path && path !== state.path) openDoc(path, { push: false });
});

const officeEditButton = document.createElement('button');
officeEditButton.id = 'office-edit-button';
officeEditButton.className = 'chip';
officeEditButton.textContent = '修改文字';
officeEditButton.hidden = true;
document.getElementById('workspace-modes').after(officeEditButton);
const officeHelpButton = document.createElement('button');
officeHelpButton.id = 'office-help-button'; officeHelpButton.className = 'chip';
officeHelpButton.textContent = '预览设置'; officeHelpButton.hidden = true;
officeHelpButton.onclick = () => {
  const path = state.path;
  showOfficeSetup(() => { if (path === state.path) renderPptx(document.getElementById('doc'), true); });
};
officeEditButton.after(officeHelpButton);
officeEditButton.addEventListener('click', async () => {
  const path = state.path;
  officeEditButton.disabled = true;
  try {
    const response = await fetch(`/api/office-text?p=${encodeURIComponent(path)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '读取失败');
    if (path !== state.path) return;
    const dialog = document.createElement('dialog');
    dialog.className = 'office-editor';
    dialog.innerHTML = '<h2>修改文字</h2><p class="office-notice">适合小范围改字，不支持重排版。文字按原文件的格式片段列出。保存生成新文件，原件及原批注保留；新文件不会自动继承批注，请核对版式与保留要求。</p><div class="office-fields"></div><footer><span role="status"></span><button class="chip" data-close>取消</button><button class="chip" data-save>保存为新文件</button></footer>';
    const fields = dialog.querySelector('.office-fields');
    for (const segment of data.segments) {
      const label = document.createElement('label');
      label.textContent = `${segment.part === 'word/document.xml' ? '正文' : segment.part.split('/').pop()} · 片段 ${segment.id.split(':').pop()}`;
      const input = document.createElement('textarea');
      input.value = segment.text; input.dataset.id = segment.id;
      label.append(input); fields.append(label);
    }
    dialog.querySelector('[data-close]').onclick = () => dialog.close();
    dialog.addEventListener('close', () => dialog.remove(), {once:true});
    dialog.querySelector('[data-save]').onclick = async (event) => {
      const button = event.currentTarget;
      const original = new Map(data.segments.map(s => [s.id,s.text]));
      const edits = [...fields.querySelectorAll('textarea')].filter(el => el.value !== original.get(el.dataset.id)).map(el => ({id:el.dataset.id,text:el.value}));
      if (!edits.length) { dialog.querySelector('[role=status]').textContent = '尚未修改文字'; return; }
      button.disabled = true;
      try {
        const res = await fetch(`/api/office-text?p=${encodeURIComponent(path)}`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:data.revision,edits})});
        const result = await res.json();
        if (!res.ok) throw new Error(result.error || '保存失败');
        dialog.close(); await loadTree(); await openDoc(result.path); toast('已另存新文件，原件不变。请核对排版。');
      } catch (error) { dialog.querySelector('[role=status]').textContent = error.message; }
      finally { button.disabled = false; }
    };
    document.body.append(dialog); dialog.showModal();
  } catch (error) { toast(error.message); }
  finally { officeEditButton.disabled = false; }
});
loadTree().then(async () => {
  syncWorkspaceModeUi();
  bindPeek($("doc")); // #doc 是稳定容器，委托一次即可覆盖后续所有重渲染
  bindPeekDrawer();
  await loadCanvas();
  const wanted = new URLSearchParams(location.search).get("doc");
  const fallback = document.querySelector("#tree .file");
  const target = wanted || (fallback && fallback.dataset.path);
  if (target) await openDoc(target, { push: false });
  if (target) history.replaceState({ doc: target }, "", `?doc=${encodeURIComponent(target)}`);
});
