import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

// 渲染 PDF 为「连续长纸：页面 canvas + 自建文本层 span」，文本层供批注锚定使用。
// 宽度自适应容器（消除横向溢出），cols 支持 1/2/3 列阅读布局。
//
// 缩放策略（2026-09-11 重做，对齐 PDF.js 官方 viewer 的做法）：
//   mozilla/pdf.js 的 pdf_viewer.css 里，`.pdfViewer` 只持有一个 `--scale-factor`，
//   `.page` 上算出 `--total-scale-factor`，canvas 是 `width:100%; height:100%`
//   —— 缩放时**只改 CSS 尺寸与 scale-factor，不重建 DOM**，位图分辨率随后异步补齐。
//   我们原来每次缩放都 `container.innerHTML = ""` 全量重建（一次捏合清空 414 个节点、
//   3.3 秒才稳定、期间整片空白），所以手感一卡一卡。
//
// 位图绘制只有一个入口 renderBitmap(rec, scale, gen)：
//   - 所有页面由 IntersectionObserver 驱动（进视口 ±900px 才画），**用的是当时的倍率**；
//     旧实现把构建时的 viewport 快照存在队列里，缩放后滚到后面的页会按旧倍率画（糊的）。
//   - 每条记录持有自己的 renderTask，开新任务前先 cancel 旧的；
//   - 画完还要再验一次代次，旧任务的结果直接丢掉，绝不覆盖新倍率。
//   - 用离屏 canvas 画好再一次性贴回：可见 canvas 全程有图，不闪白。

window.renderPdfToContainer = async function renderPdfToContainer(container, url, { cols = 1, maxScale = 1.4, zoom = 1 } = {}) {
  container.innerHTML = "";
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  window.__coeditorPdfDoc = { container, pdf, url, cols }; // 缓存文档句柄：缩放时不重开文件
  return buildPdfPages(container, pdf, cols, maxScale, zoom);
};

/** 当前视图记录：缩放时改它，不重建 DOM */
let view = null;
let sharpenTimer = null;

/** 第一步：只改尺寸（同步、便宜）。返回新的 scale。 */
window.setPdfZoom = function setPdfZoom(container, zoom) {
  const v = view;
  if (!v || v.container !== container) return null;
  const scale = v.fitScale * zoom;
  v.zoom = zoom;
  v.scale = scale;
  v.gen += 1; // 代次：所有在飞的位图任务作废，不得回写到新尺寸上
  for (const rec of v.records) {
    const vp = rec.page.getViewport({ scale });
    rec.viewport = vp;
    rec.wrapper.style.width = `${vp.width}px`;
    rec.wrapper.style.height = `${vp.height}px`;
    rec.wrapper.style.setProperty("--total-scale-factor", String(vp.scale));
    // 旧位图先按 CSS 尺寸拉伸顶上去：立刻有反馈，稍后再换高清
    rec.canvas.style.width = `${vp.width}px`;
    rec.canvas.style.height = `${vp.height}px`;
    rec.sharpScale = null;
  }
  scheduleSharpen();
  return { scale, zoom };
};

/** 缩放后：把「当前就在视口里」的页按新倍率重画一遍
    （IntersectionObserver 只在进出视口时触发，已经可见的页不会自己再触发） */
function scheduleSharpen() {
  clearTimeout(sharpenTimer);
  sharpenTimer = setTimeout(() => { sharpen().catch(() => {}); }, 180);
}

async function sharpen() {
  const v = view;
  if (!v || !v.scale) return;
  const gen = v.gen;
  const near = nearViewport(v);
  for (const rec of v.records) {
    if (gen !== v.gen) return; // 又缩放过：这一轮全部作废
    if (rec.sharpScale === v.scale) continue;
    if (!near(rec.wrapper)) continue; // 远处的页等滚进来再画（由 observer 负责）
    await renderBitmap(rec, v.scale, gen);
  }
}

/** 进视口就按「当前倍率」补齐——这是远页清晰的关键 */
function startObserver(v) {
  v.io?.disconnect();
  if (!("IntersectionObserver" in window)) {
    v.records.forEach((rec) => ensureSharp(rec));
    return;
  }
  const scroller = v.container.closest("#viewport") || null;
  v.io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const rec = v.records.find((r) => r.wrapper === entry.target);
      if (rec) ensureSharp(rec);
    }
  }, { root: scroller, rootMargin: "900px 0px" });
  v.records.forEach((rec) => v.io.observe(rec.wrapper));
}

function nearViewport(v) {
  const scroller = v.container.closest("#viewport");
  const vr = scroller ? scroller.getBoundingClientRect() : { top: -1e9, bottom: 1e9 };
  return (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom >= vr.top - 900 && r.top <= vr.bottom + 900;
  };
}

function ensureSharp(rec) {
  const v = view;
  if (!v || !v.scale) return null;
  if (rec.sharpScale === v.scale) return null; // 已经是当前倍率，不重复画
  return renderBitmap(rec, v.scale, v.gen);
}

/** 唯一的位图入口：离屏画好再贴回；旧任务先取消，过期结果直接丢 */
async function renderBitmap(rec, scale, gen) {
  if (rec.task) { try { rec.task.cancel(); } catch { /* 已结束 */ } rec.task = null; }
  const viewport = rec.page.getViewport({ scale });
  const outputScale = Math.max(1, window.devicePixelRatio || 1);
  const off = document.createElement("canvas");
  off.width = Math.max(1, Math.floor(viewport.width * outputScale));
  off.height = Math.max(1, Math.floor(viewport.height * outputScale));
  const task = rec.page.render({
    canvasContext: off.getContext("2d"),
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
  });
  rec.task = task;
  try {
    await task.promise;
  } catch (error) {
    rec.task = null;
    if (String(error?.name || "").includes("Cancelled")) return; // 被更新的任务顶掉了，静默
    markPaintError(rec, error);
    return;
  }
  rec.task = null;
  if (gen !== view?.gen || !rec.canvas.isConnected) return; // 期间又缩放/换文档：旧结果丢弃
  rec.canvas.width = off.width;
  rec.canvas.height = off.height;
  rec.canvas.style.width = `${viewport.width}px`;
  rec.canvas.style.height = `${viewport.height}px`;
  rec.canvas.getContext("2d").drawImage(off, 0, 0);
  rec.canvas.dataset.painted = "1";
  rec.sharpScale = scale;
  rec.wrapper.querySelector(".pdf-retry")?.remove();
  rec.wrapper.classList.remove("pdf-paint-error");
}

function markPaintError(rec, error) {
  rec.canvas.dataset.painted = "error";
  rec.wrapper.classList.add("pdf-paint-error");
  if (rec.wrapper.querySelector(".pdf-retry")) return;
  const bar = document.createElement("div");
  bar.className = "pdf-retry";
  bar.innerHTML = `<span>本页渲染失败：${String(error && error.message || error).slice(0, 80)}</span>`;
  const retry = document.createElement("button");
  retry.textContent = "重试";
  retry.addEventListener("click", () => { rec.canvas.dataset.painted = ""; rec.sharpScale = null; ensureSharp(rec); });
  bar.appendChild(retry);
  rec.wrapper.appendChild(bar);
}

async function buildPdfPages(container, pdf, cols, maxScale, zoom = 1) {
  const scrollTop = container.closest("#viewport")?.scrollTop || 0;
  const first = await pdf.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const cs = getComputedStyle(container);
  const innerW = container.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
  const avail = Math.max(320, innerW || 600); // 内容盒宽（不含 padding），多列才能放得下
  const gap = 16;
  const pageW = cols === 1
    ? avail
    : Math.floor((avail - gap * (cols - 1)) / cols);
  const fitScale = Math.min(maxScale, pageW / base.width);
  const scale = fitScale * zoom; // zoom 因子：>1 = 放大并产生内部滚动，与其他 PDF 阅读器同语义
  container.classList.toggle("pdf-multi", cols > 1);

  const outputScale = Math.max(1, window.devicePixelRatio || 1);

  let text = "";
  const textJobs = [];
  const records = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.dataset.page = String(pageNumber);
    // PDF.js TextLayer uses these variables for both its bounds and glyph sizes.
    wrapper.style.setProperty("--total-scale-factor", String(viewport.scale));
    wrapper.style.setProperty("--scale-round-x", "1px");
    wrapper.style.setProperty("--scale-round-y", "1px");
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;
    wrapper.style.marginBottom = `${gap}px`;

    // HiDPI：CSS 尺寸维持阅读布局，像素缓冲按设备倍率
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    wrapper.appendChild(canvas);

    const layer = document.createElement("div");
    layer.className = "pdf-text textLayer"; // textLayer = 官方类名（配官方样式）；pdf-text 保留给锚定/样式选择器
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    wrapper.appendChild(layer);

    // 区域批注层（苹果预览式框选）：在文本层之上，pointer-events:none 不挡文字选择
    const regions = document.createElement("div");
    regions.className = "region-layer";
    wrapper.appendChild(regions);

    container.appendChild(wrapper);

    const rec = { pageNumber, page, wrapper, canvas, layer, viewport, sharpScale: null, task: null };
    records.push(rec);

    // 文本提取（批注锚定、全文提取、检索都依赖 text 字符串）与文字层渲染解耦
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str) continue;
      text += item.str;
      if (item.hasEOL) text += "\n";
    }

    // 官方 TextLayer 并行渲染：占位结构按页序即时出现，首屏不被长文档的串行 DOM 构建阻塞
    const textLayer = new pdfjsLib.TextLayer({ textContentSource: content, container: layer, viewport });
    textJobs.push(textLayer.render());
  }
  await Promise.all(textJobs);

  view = { container, pdf, cols, maxScale, fitScale, zoom, scale, records, gen: 0, io: null };

  // 扫描件（无文字层）：明确说明能力边界——区域批注可用，不承诺不存在的 OCR
  if (!text.trim() && pdf.numPages > 0 && !container.querySelector(".pdf-scan-hint")) {
    const hint = document.createElement("div");
    hint.className = "pdf-scan-hint";
    hint.innerHTML = "这份 PDF 没有文字层（可能是扫描件）：无法选择文字或按段落批注，<b>建议用「区域批注」（R）框选</b>后写意见。";
    container.prepend(hint);
  }

  // 缩放后恢复阅读位置（上下偏差可控，优先不出视口）
  if (scrollTop > 0) container.closest("#viewport").scrollTop = scrollTop;

  // 统一由 observer + sharpen 驱动绘制：首屏那几页会立刻被判定为「视口内」
  startObserver(view);
  view.records.filter((rec) => nearViewport(view)(rec.wrapper)).forEach((rec) => ensureSharp(rec));

  return { text, pages: pdf.numPages, scale, cols };
}

/* ---------------- 单页渲染（PPTX 幻灯片视图用） ----------------
   缩略图轨一次要画十几页，每页都 getDocument 会重复下载/解析同一份 PDF。
   这里按 url 缓存文档句柄；url 内含内容哈希，文件变了 url 就变，不会读到旧句柄。 */
const pdfDocCache = new Map();
function getPdfDoc(url) {
  if (!pdfDocCache.has(url)) {
    const task = pdfjsLib.getDocument({ url });
    pdfDocCache.set(url, task.promise);
    task.promise.catch(() => pdfDocCache.delete(url)); // 失败不留坏句柄，允许重试
  }
  return pdfDocCache.get(url);
}

window.pdfPageCount = async function pdfPageCount(url) {
  const pdf = await getPdfDoc(url);
  return pdf.numPages;
};

/** 把 PDF 的第 pageNumber 页画进 target（清空 target），返回 CSS 尺寸。 */
window.renderPdfPage = async function renderPdfPage(url, pageNumber, target, { width = 480 } = {}) {
  const pdf = await getPdfDoc(url);
  const page = await pdf.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.max(0.05, width / base.width) });
  const outputScale = Math.max(1, window.devicePixelRatio || 1);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
  canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
  canvas.style.width = `${viewport.width}px`;
  canvas.style.height = `${viewport.height}px`;
  target.innerHTML = "";
  target.appendChild(canvas);
  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
    transform: outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0],
  }).promise;
  return { width: viewport.width, height: viewport.height };
};

// 列布局切换：重渲染当前 PDF（app.js 调用）。列数变化要重新排版，这条走完整重建。
window.rerenderPdfWithCols = async function rerenderPdfWithCols(container, url, cols) {
  const zoom = view && view.container === container ? (view.zoom || 1) : 1;
  return renderPdfToContainer(container, url, { cols, maxScale: 1.4, zoom });
};
