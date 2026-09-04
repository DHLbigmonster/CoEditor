// E2E：浮条弹出 → 高亮 → 编辑模式 → 保存 → 白板
(async () => {
  const out = {};
  const vp = document.querySelector("#viewport");
  const $ = (id) => document.getElementById(id);

  // 1) 选中一段文字 → mouseup → 浮条应出现
  const doc = $("doc");
  const walker = document.createTreeWalker(doc, NodeFilter.SHOW_TEXT);
  let target = null;
  while (walker.nextNode()) {
    if (walker.currentNode.textContent.includes("1,208 家门店")) { target = walker.currentNode; break; }
  }
  if (!target) return "no target text node";
  const idx = target.textContent.indexOf("1,208 家门店");
  const range = document.createRange();
  range.setStart(target, idx);
  range.setEnd(target, idx + 9);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  const rect = range.getBoundingClientRect();
  $("page").dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: rect.left, clientY: rect.top }));
  await new Promise(r => setTimeout(r, 100));
  const menu = $("sel-menu");
  out.menuShown = !menu.hidden;

  // 2) 点「高亮」→ 直接创建 mark 批注
  menu.querySelector('[data-sel-act="highlight"]').click();
  await new Promise(r => setTimeout(r, 900));
  out.composerHidden = $("composer").hidden; // 高亮不应弹 composer
  out.hlCount = document.querySelectorAll('.anchor[data-kind="highlight"]').length;

  // 3) 双击进编辑模式
  $("page").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 700, clientY: 400 }));
  await new Promise(r => setTimeout(r, 200));
  out.editorOn = document.body.classList.contains("editing-doc") && !!document.getElementById("md-editor");
  out.editorValueHead = ($("md-editor")?.value || "").slice(0, 20);

  // 4) 改一个字并 ⌘S 保存（用保存按钮等价触发）
  const editor = $("md-editor");
  editor.value = editor.value.replace("覆盖 1,208 家门店", "覆盖 1,209 家门店");
  $("edit-save").click();
  await new Promise(r => setTimeout(r, 1200));
  out.editorOff = !document.body.classList.contains("editing-doc");
  out.editApplied = (doc.innerText || "").includes("1,209 家门店");

  // 5) 白板：模拟 board 工具 + 画布空白处 mousedown
  document.querySelector('[data-tool="board"]').click();
  vp.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 300, clientY: 650, button: 0 }));
  await new Promise(r => setTimeout(r, 800));
  out.boardCount = document.querySelectorAll(".note.board").length;

  return JSON.stringify(out, null, 1);
})()
