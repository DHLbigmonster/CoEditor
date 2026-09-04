import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

// 渲染 PDF 为「连续长纸：页面 canvas + 自建文本层 span」，文本层供批注锚定使用。
// 宽度自适应容器（消除横向溢出），cols 支持 1/2/3 列阅读布局。
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

    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
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

    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context, viewport }).promise;

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
  }
  return { text, pages: pdf.numPages, scale, cols };
};

// 列布局切换：重渲染当前 PDF（app.js 调用）
window.rerenderPdfWithCols = async function rerenderPdfWithCols(container, url, cols) {
  return renderPdfToContainer(container, url, { cols, maxScale: 1.4 });
};
