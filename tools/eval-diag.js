// 诊断：md 视野下的 image-card / draft-card 是否被错误渲染 + 批注卡位置
(() => {
  const imgs = [...document.querySelectorAll(".image-card")].map(n => ({
    id: n.dataset.id, left: n.style.left, top: n.style.top, visible: n.offsetWidth > 0
  }));
  const drafts = [...document.querySelectorAll(".draft-card")].map(n => n.dataset.id);
  const cards = [...document.querySelectorAll(".note-card, .a-card, [class*=card]")].slice(0, 3).map(n => n.className);
  const docImgs = [...document.querySelectorAll(".doc-view img, img")].map(i => ({
    src: (i.getAttribute("src") || "").slice(0, 60), top: Math.round(i.getBoundingClientRect().top), h: Math.round(i.getBoundingClientRect().height)
  }));
  return JSON.stringify({ imgs, drafts, cards, docImgs }, null, 1);
})()
