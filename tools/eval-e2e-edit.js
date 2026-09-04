// E2E v2：编辑保存闭环（改 → 存 → 验证渲染 → 恢复原值再存，文件无损）
(async () => {
  const out = {};
  const $ = (id) => document.getElementById(id);
  $("page").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 700, clientY: 400 }));
  await new Promise(r => setTimeout(r, 200));
  out.editorOn = !!$("md-editor");
  const editor = $("md-editor");
  const original = editor.value;
  editor.value = original.replace("覆盖 1,208 家门店", "覆盖 1,209 家门店");
  $("edit-save").click();
  await new Promise(r => setTimeout(r, 1300));
  out.editApplied = ($("doc").innerText || "").includes("1,209 家门店"); // 渲染已用新文本
  out.editorOff = !document.body.classList.contains("editing-doc");
  // 恢复原值再存一次（文件无损收尾）
  $("page").dispatchEvent(new MouseEvent("dblclick", { bubbles: true, clientX: 700, clientY: 400 }));
  await new Promise(r => setTimeout(r, 200));
  $("md-editor").value = original;
  $("edit-save").click();
  await new Promise(r => setTimeout(r, 1300));
  out.restored = ($("doc").innerText || "").includes("1,208 家门店") && !($("doc").innerText || "").includes("1,209");
  return JSON.stringify(out);
})()
