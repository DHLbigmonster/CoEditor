// 桌面版（CoEditor.app）专属的两件界面：首次引导 + 「退出 CoEditor」。
//
// 为什么单独一个文件：它是"启动器"的配套，不是阅读器本身的功能。
// 命令行启动时 /api/app/info 会说 desktop:false，这里就什么都不做——
// 网页版用户看到的界面和以前完全一样。
//
// 只做两件事：
//   1. 首次打开（服务端标记 firstRun）：给「选择文件夹」和「先看示例」，不挡住阅读
//   2. 桌面模式：在左下角给一个明确的「退出 CoEditor」，停掉后台服务
(function () {
  const api = (path, options) => fetch(path, options).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  /* ---------------- 样式：内联注入，避免动别人的样式文件 ---------------- */
  const style = document.createElement("style");
  style.textContent = `
  .dsk-first { position: fixed; inset: 0; z-index: 200; display: grid; place-items: center;
    background: rgba(30, 28, 24, .38); backdrop-filter: blur(3px); }
  .dsk-first[hidden] { display: none; }
  .dsk-card { width: min(440px, calc(100vw - 40px)); padding: 26px 26px 22px;
    background: #fffefa; border: 1px solid #e6e8e1; border-radius: 14px;
    box-shadow: 0 24px 60px rgba(25, 22, 16, .22); text-align: left; }
  .dsk-card h2 { margin: 0 0 10px; font-size: 21px; letter-spacing: -.01em; color: #252923; }
  .dsk-card p { margin: 0 0 18px; font-size: 14px; line-height: 1.75; color: #62675f; }
  .dsk-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .dsk-btn { flex: 1 1 auto; padding: 10px 16px; border-radius: 9px; font: inherit; font-size: 14px;
    cursor: pointer; border: 1px solid #e6e8e1; background: #fff; color: #252923; white-space: nowrap; }
  .dsk-btn:hover { border-color: #cfd2c8; }
  .dsk-btn.primary { background: #42664d; border-color: #42664d; color: #fff; }
  .dsk-btn.primary:hover { background: #37543f; }
  .dsk-btn[disabled] { opacity: .6; cursor: default; }
  .dsk-quit { display: flex; align-items: center; gap: 6px; margin-top: 8px;
    padding: 4px 10px; border-radius: 999px; cursor: pointer;
    border: 1px solid #dedfd5; background: #fffefa; color: #5b6156; font: inherit; font-size: 11px; }
  .dsk-quit:hover { background: #fff; border-color: #cfd1c6; color: #8a3b2e; }
  .dsk-note { margin-top: 14px; font-size: 12px; color: #8b8f87; }
  body.paper-dark .dsk-card { background: #221f19; border-color: #3a352c; color: #e6e1d6; }
  body.paper-dark .dsk-card h2 { color: #e6e1d6; }
  body.paper-dark .dsk-card p { color: #b3aea2; }
  `;
  document.head.appendChild(style);

  /* ---------------- 首次引导 ---------------- */
  function showFirstRun() {
    const box = document.createElement("div");
    box.className = "dsk-first";
    box.innerHTML = `
      <div class="dsk-card" role="dialog" aria-modal="true" aria-labelledby="dsk-title">
        <h2 id="dsk-title">把修改意见留在文档上。</h2>
        <p>选择电脑上的一个文件夹，就能开始阅读和批注。文件保存在本机，不会上传。</p>
        <div class="dsk-actions">
          <button class="dsk-btn primary" data-dsk="pick">选择文件夹</button>
          <button class="dsk-btn" data-dsk="sample">先看示例</button>
        </div>
        <div class="dsk-note" data-dsk="note">示例是随应用附带的合成文档，可以随便试。</div>
      </div>`;
    document.body.appendChild(box);

    const note = box.querySelector('[data-dsk="note"]');
    box.addEventListener("click", async (event) => {
      const act = event.target.getAttribute?.("data-dsk");
      if (!act) return;
      if (act === "sample") { box.hidden = true; return; }

      const pick = box.querySelector('[data-dsk="pick"]');
      pick.disabled = true;
      note.textContent = "已打开系统选择窗口，请在弹窗里选一个文件夹…";
      // 原生选择器由服务端拉起；取消返回 409，此时不改动当前目录
      const picked = await api("/api/folder-picker", { method: "POST" });
      if (!picked || !picked.path) {
        pick.disabled = false;
        note.textContent = "没有选择文件夹。可以重试，或先看示例。";
        return;
      }
      const switched = await api("/api/vault", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: picked.path }),
      });
      if (!switched) {
        pick.disabled = false;
        note.textContent = "打开失败，可能没有读取权限。换一个文件夹试试。";
        return;
      }
      note.textContent = "已打开，正在载入…";
      location.reload();
    });
  }

  /* ---------------- 「退出 CoEditor」 ---------------- */
  function addQuitEntry(info) {
    const foot = document.querySelector(".rail-foot");
    if (!foot || foot.querySelector(".dsk-quit")) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dsk-quit";
    btn.title = "停止后台服务。批注已经保存在你的文件夹里，下次打开还在。";
    btn.textContent = "⏻ 退出 CoEditor";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "正在退出…";
      await fetch("/api/app/quit", { method: "POST" }).catch(() => {});
      // 服务停了，页面留着也没用；给一句明确的收尾
      document.body.innerHTML =
        '<div style="display:grid;place-items:center;height:100vh;font:15px/1.8 -apple-system,\'PingFang SC\',sans-serif;color:#62675f;text-align:center">'
        + '<div>CoEditor 已退出，后台服务已停止。<br>批注保存在你的文件夹里，下次双击图标即可继续。<br><br>'
        + '<span style="font-size:13px;color:#8b8f87">这个页面可以关掉了。</span></div></div>';
    });
    foot.appendChild(btn);
  }

  /* ---------------- 入口 ---------------- */
  (async () => {
    const info = await api("/api/app/info");
    if (!info || !info.desktop) return; // 命令行启动：什么都不做
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => addQuitEntry(info), { once: true });
    } else {
      addQuitEntry(info);
    }
    if (info.firstRun) {
      const show = () => showFirstRun();
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", show, { once: true });
      else show();
    }
  })();
})();
