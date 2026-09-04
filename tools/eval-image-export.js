// image-export.png：配图文档 → 导出标注图（抽屉自动展开）
(async () => {
  await new Promise(r => setTimeout(r, 1200)); // 等图片加载
  const exp = [...document.querySelectorAll("button")].find(b => b.textContent.includes("导出标注图"));
  if (!exp) return "no export btn";
  exp.click();
  await new Promise(r => setTimeout(r, 2200));
  const drawer = document.querySelector("#drawer");
  return "drawer hidden=" + (drawer ? drawer.hidden : "none");
})()
