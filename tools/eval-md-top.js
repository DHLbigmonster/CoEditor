// md.png：86% 缩放（1.1^11），顶部回正 + 轻微左移保批注卡完整
(() => {
  const vp = document.querySelector("#viewport");
  const wh = (d) => vp.dispatchEvent(new WheelEvent("wheel", {
    deltaY: d.y || 0, deltaX: d.x || 0, ctrlKey: !!d.c,
    clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true
  }));
  for (let i = 0; i < 11; i++) wh({ y: -100, c: 1 }); // 30%→86%
  wh({ y: -400 }); wh({ y: -400 });                    // 顶部拉回
  const h = document.querySelector("#doc h1");
  const t = h ? h.getBoundingClientRect().top : -1;
  return "h1 top=" + Math.round(t);
})()
