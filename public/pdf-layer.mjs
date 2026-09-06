import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

// 渲染 PDF 为「连续长纸：页面 canvas + 自建文本层 span」，文本层供批注锚定使用。
// 宽度自适应容器（消除横向溢出），cols 支持 1/2/3 列阅读布局。
// v0.7.5：画布按需绘制（IntersectionObserver）——文本层与结构即时建立（锚定/检索/批注不受影响），
// 昂贵的 page.render 只画视口附近（±900px）的页面；长文档不再全量渲染卡顿。

window.renderPdfToContainer = async function renderPdfToContainer(container, url, { cols = 1, maxScale = 1.4, zoom = 1 } = {}) {
  container.innerHTML = "";
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  window.__coeditorPdfDoc = { container, pdf, url, cols }; // 缓存文档句柄：缩放时不重开文件
  return buildPdfPages(container, pdf, cols, maxScale, zoom);
};

/* 缩放（app.js 在 view.zoom 变化时防抖调用）：zoom=1 = 适合容器宽；
   >1 时页面按比例放大并产生内部滚动，文档句柄复用不重开。 */
window.setPdfZoom = async function setPdfZoom(container, zoom) {
  const state = window.__coeditorPdfDoc;
  if (!state || state.container !== container) return null;
  container.innerHTML = ""; // 旧页面先清掉，否则新页面追加在后面、锚点和量测全落在旧 DOM
  const cols = container.classList.contains("pdf-multi") ? 2 : 1;
  return buildPdfPages(container, state.pdf, cols, 1.4, zoom);
};

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
  const paintQueue = [];
  let paintChain = Promise.resolve();

  const paint = (item) => {
    paintChain = paintChain
      .then(async () => {
        if (item.canvas.dataset.painted === "1" || !item.canvas.isConnected) return;
        try {
          const context = item.canvas.getContext("2d");
          const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
          await item.page.render({ canvasContext: context, viewport: item.viewport, transform }).promise;
          item.canvas.dataset.painted = "1"; // 真正画完才算 painted——失败留空不能冒充加载成功
          item.wrapper.querySelector(".pdf-retry")?.remove();
          item.wrapper.classList.remove("pdf-paint-error");
        } catch (error) {
          item.canvas.dataset.painted = "error";
          if (item.wrapper) {
            item.wrapper.classList.add("pdf-paint-error");
            const bar = document.createElement("div");
            bar.className = "pdf-retry";
            bar.innerHTML = `<span>本页渲染失败：${String(error && error.message || error).slice(0, 80)}</span>`;
            const retry = document.createElement("button");
            retry.textContent = "重试";
            retry.addEventListener("click", () => { item.canvas.dataset.painted = ""; paint(item); });
            bar.appendChild(retry);
            item.wrapper.appendChild(bar);
          }
        }
      });
    return paintChain;
  };

  let text = "";
  const textJobs = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.dataset.page = String(pageNumber);
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

    // 首屏两页立即绘制，其余进入按需队列（item 必须带 wrapper：失败重试 UI 要挂上去，
    // 而且任何一项的异常都不能污染 paintChain 导致后续页永不绘制）
    const item = { page, canvas, viewport, wrapper };
    if (pageNumber <= 2) {
      paint(item);
    } else {
      paintQueue.push(item);
    }
  }
  await Promise.all(textJobs);

  // 扫描件（无文字层）：明确说明能力边界——区域批注可用，不承诺不存在的 OCR
  if (!text.trim() && pdf.numPages > 0 && !container.querySelector(".pdf-scan-hint")) {
    const hint = document.createElement("div");
    hint.className = "pdf-scan-hint";
    hint.innerHTML = "这份 PDF 没有文字层（可能是扫描件）：无法选择文字或按段落批注，<b>建议用「区域批注」（R）框选</b>后写意见。";
    container.prepend(hint);
  }

  // 缩放后恢复阅读位置（上下偏差可控，优先不出视口）
  if (scrollTop > 0) container.closest("#viewport").scrollTop = scrollTop;

  // 按需绘制：页面滚进视口 ±900px 才真正 render（两种模式都生效——IO 对 transform 位移同样响应）
  if (paintQueue.length) {
    const scrollRoot = container.closest("#viewport") || null;
    if ("IntersectionObserver" in window) {
      const io = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const item = paintQueue.find((p) => p.wrapper === entry.target);
          if (!item) continue;
          paint(item);
          paintQueue.splice(paintQueue.indexOf(item), 1);
          io.unobserve(entry.target);
        }
      }, { root: scrollRoot, rootMargin: "900px 0px" });
      paintQueue.forEach((p) => io.observe(p.wrapper));
    } else {
      paintQueue.forEach((p) => paint(p)); // 兜底：无 IO 就全画
    }
  }

  return { text, pages: pdf.numPages, scale, cols };
};

// 列布局切换：重渲染当前 PDF（app.js 调用）
window.rerenderPdfWithCols = async function rerenderPdfWithCols(container, url, cols) {
  const zoom = window.__coeditorPdfDoc && window.__coeditorPdfDoc.container === container ? (window.__coeditorPdfZoom || 1) : 1;
  return renderPdfToContainer(container, url, { cols, maxScale: 1.4, zoom });
};
