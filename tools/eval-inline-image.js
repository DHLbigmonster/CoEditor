// inline-image.png：86% 缩放 + 循环逼近到内嵌配图居中
(() => {
  const vp = document.querySelector("#viewport");
  const wh = (deltaY, ctrl) => vp.dispatchEvent(new WheelEvent("wheel", {
    deltaY, ctrlKey: !!ctrl, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true
  }));
  for (let i = 0; i < 11; i++) wh(-100, true); // 30%→86%
  const img = document.querySelector("#doc img");
  if (!img) return "no img";
  let guard = 0;
  while (guard++ < 80) {
    const top = img.getBoundingClientRect().top;
    const dy = top - innerHeight * 0.22;      // 图片顶到视口 22% 高度处（图+图注都入画）
    if (Math.abs(dy) < 30) break;
    wh(Math.max(-700, Math.min(700, dy * 0.9)));
  }
  const r = img.getBoundingClientRect();
  const badge = [...document.querySelectorAll(".region-badge, .anchor")].length;
  return "img top=" + Math.round(r.top) + " h=" + Math.round(r.height) + " regions=" + badge;
})()
