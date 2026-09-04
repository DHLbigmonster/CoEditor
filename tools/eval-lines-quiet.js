// lines-quiet.png：86% 顶部视图 + 开启「连线」降噪
(() => {
  const vp = document.querySelector("#viewport");
  const wh = (d) => vp.dispatchEvent(new WheelEvent("wheel", {
    deltaY: d.y || 0, ctrlKey: !!d.c, clientX: innerWidth / 2, clientY: innerHeight / 2, bubbles: true, cancelable: true
  }));
  for (let i = 0; i < 11; i++) wh({ y: -100, c: 1 });
  wh({ y: -400 }); wh({ y: -400 });
  const btn = [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "连线");
  if (btn) btn.click();
  return "quiet=" + (btn ? btn.classList.contains("on") || btn.classList.contains("active") : "no-btn");
})()
