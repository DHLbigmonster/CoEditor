import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

// 渲染 PDF 为「连续长纸：页面 canvas + 自建文本层 span」，文本层供批注锚定使用。
// 宽度自适应容器（消除横向溢出），cols 支持 1/2/3 列阅读布局。
// v0.7.5：画布按需绘制（IntersectionObserver）——文本层与结构即时建立（锚定/检索/批注不受影响），
// 昂贵的 page.render 只画视口附近（±900px）的页面；长文档不再全量渲染卡顿。

window.renderPdfToContainer = async function renderPdfToContainer(container, url, { cols = 1, maxScale = 1.4 } = {}) {
  container.innerHTML = "";
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  const first = await pdf.getPage(1);
  const base = first.getViewport({ scale: 1 });
  const cs = getComputedStyle(container);
  const innerW = container.clientWidth - parseFloat(cs.paddingLeft || "0") - parseFloat(cs.paddingRight || "0");
  const avail = Math.max(320, innerW || 600); // 内容盒宽（不含 padding），多列才能放得下
  const gap = 16;
  const pageW = cols === 1
    ? avail
    : Math.floor((avail - gap * (cols - 1)) / cols);
  const scale = Math.min(maxScale, pageW / base.width);
  container.classList.toggle("pdf-multi", cols > 1);

  const outputScale = Math.max(1, window.devicePixelRatio || 1);
  const paintQueue = [];
  let paintChain = Promise.resolve();

  const paint = (item) => {
    paintChain = paintChain
      .then(async () => {
        if (item.canvas.dataset.painted || !item.canvas.isConnected) return;
        item.canvas.dataset.painted = "1";
        const context = item.canvas.getContext("2d");
        const transform = outputScale === 1 ? null : [outputScale, 0, 0, outputScale, 0, 0];
        await item.page.render({ canvasContext: context, viewport: item.viewport, transform }).promise;
      })
      .catch(() => {}); // 单页绘制失败不阻塞队列
    return paintChain;
  };

  let text = "";
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
    layer.className = "pdf-text";
    layer.style.width = `${viewport.width}px`;
    layer.style.height = `${viewport.height}px`;
    wrapper.appendChild(layer);

    // 区域批注层（苹果预览式框选）：在文本层之上，pointer-events:none 不挡文字选择
    const regions = document.createElement("div");
    regions.className = "region-layer";
    wrapper.appendChild(regions);

    container.appendChild(wrapper);

    // 文本层即时建立（批注锚定、全文提取、检索都依赖它）
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str) continue;
      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]) || 12;
      const span = document.createElement("span");
      span.textContent = item.str;
      span.style.position = "absolute";
      span.style.left = `${tx[4]}px`;
      span.style.top = `${tx[5] - fontHeight}px`;
      span.style.fontSize = `${fontHeight}px`;
      span.style.lineHeight = `${fontHeight}px`;
      span.style.transformOrigin = "left top";
      span.style.whiteSpace = "pre";
      layer.appendChild(span);
      text += item.str;
      if (item.hasEOL) text += "\n";
    }

    // 首屏两页立即绘制，其余进入按需队列
    if (pageNumber <= 2) {
      paint({ page, canvas, viewport });
    } else {
      paintQueue.push({ page, canvas, viewport, wrapper });
    }
  }

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
  return renderPdfToContainer(container, url, { cols, maxScale: 1.4 });
};
