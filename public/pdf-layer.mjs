import * as pdfjsLib from "/vendor/pdfjs/pdf.min.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.mjs";

// 渲染 PDF 为「页面 canvas + 自建文本层 span」，文本层供批注锚定使用
window.renderPdfToContainer = async function renderPdfToContainer(container, url, scale = 1.4) {
  container.innerHTML = "";
  const pdf = await pdfjsLib.getDocument({ url }).promise;
  let text = "";
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale });
    const wrapper = document.createElement("div");
    wrapper.className = "pdf-page";
    wrapper.dataset.page = String(pageNumber);
    wrapper.style.width = `${viewport.width}px`;
    wrapper.style.height = `${viewport.height}px`;

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
  return { text, pages: pdf.numPages };
};
