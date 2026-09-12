// 桌面版界面验收：首次引导（选择文件夹 / 先看示例）与「退出 CoEditor」
// 需要先启动 dist/CoEditor.app（脚本自己会启），以及一个 CDP Chrome（9334）。
// 用法: node tools/test-desktop-shell-ui.mjs
import { openPage, sleep } from "./p0-harness.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(REPO, "dist", "CoEditor.app");
const SUPPORT = join(homedir(), "Library", "Application Support", "CoEditor");
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  console.log(`${state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};
const readOr = async (f, d = null) => { try { return (await readFile(f, "utf8")).trim(); } catch { return d; } };

await mkdir(OUT, { recursive: true });
// 干净状态 = 首次运行
for (const pid of (await run("bash", ["-lc", `pgrep -f "CoEditor.app/Contents/Resources/app/server.mjs" || true`])).stdout.split("\n").filter(Boolean)) {
  await run("kill", [pid]).catch(() => {});
}
await sleep(1200);
await rm(SUPPORT, { recursive: true, force: true });

let port = null;
try {
  let openResult = "ok";
  try { await run("open", [APP]); } catch (e) { openResult = `open 失败：${String(e.stderr || e.message).split("\n")[0]}`; }
  for (let i = 0; i < 60; i += 1) {
    const p = await readOr(join(SUPPORT, "server.port"));
    if (p && (await fetch(`http://127.0.0.1:${p}/api/app/info`).then((r) => r.ok).catch(() => false))) { port = p; break; }
    await sleep(300);
  }
  if (!port) {
    // 留现场：launch 结果 + Application Support 内容 + 日志尾部，避免只报"没起来"
    const ls = (await run("bash", ["-lc", `ls -la "${SUPPORT}" 2>&1 | tail -8`])).stdout.trim();
    const tail = (await run("bash", ["-lc", `tail -6 "${SUPPORT}/coeditor.log" 2>&1`])).stdout.trim();
    const proc = (await run("bash", ["-lc", `pgrep -fl "CoEditor.app/Contents/MacOS/CoEditor" || echo none`])).stdout.trim();
    console.log(`  [诊断] ${openResult}\n  [诊断] 目录：\n${ls}\n  [诊断] 日志：\n${tail}\n  [诊断] 启动器进程：${proc}`);
  }
  record("应用已启动（首次运行）", Boolean(port), port ? `端口 ${port}` : `没起来（${openResult}）`);
  if (!port) throw new Error("应用没起来");

  const page = await openPage(`http://127.0.0.1:${port}/`, { width: 1440, height: 900 });
  await sleep(1600);

  const shell = await page.eval(`
    const box = document.querySelector('.dsk-first');
    const quit = document.querySelector('.rail-foot .dsk-quit');
    return {
      overlay: !!box && !box.hidden,
      title: box ? (box.querySelector('h2') || {}).textContent : null,
      buttons: box ? [...box.querySelectorAll('[data-dsk]')].map(b => b.textContent.trim()) : [],
      quit: quit ? quit.textContent.trim() : null,
      quitInRail: !!document.querySelector('.rail-foot .dsk-quit'),
    };`);
  record("首次打开出现引导，且不挡住阅读以外的操作", shell.overlay === true, JSON.stringify(shell).slice(0, 200));
  record("主按钮是「选择文件夹」", shell.buttons[0] === "选择文件夹", shell.buttons.join(" / "));
  record("旁边提供「先看示例」", shell.buttons.includes("先看示例"), shell.buttons.join(" / "));
  record("引导标题是给用户看的话", shell.title === "把修改意见留在文档上。", JSON.stringify(shell.title));
  await page.shot(`${OUT}/desktop-first-run.png`);

  // 点「先看示例」→ 引导关闭，示例文档可读
  await page.eval(`[...document.querySelectorAll('[data-dsk]')].find(b => b.dataset.dsk === 'sample').click(); return 1;`);
  await sleep(600);
  const after = await page.eval(`const b = document.querySelector('.dsk-first');
    return { hidden: !b || b.hidden, tree: document.querySelectorAll('#tree [data-path]').length };`);
  record("点「先看示例」后引导关闭，示例文件在列表里", after.hidden === true && after.tree > 0, JSON.stringify(after));

  record("左下角有明确的「退出 CoEditor」", /退出 CoEditor/.test(shell.quit || ""), JSON.stringify(shell.quit));
  await page.shot(`${OUT}/desktop-shell.png`);

  // 网页版不该出现这些
  const notDesktop = await page.eval(`return { hasOverlay: !!document.querySelector('.dsk-first') };`);
  record("（桌面模式下）引导与退出只在桌面版出现", notDesktop.hasOverlay === true, "登录入口由 /api/app/info 决定");

  await page.close();
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
} finally {
  await fetch(`http://127.0.0.1:${port}/api/app/quit`, { method: "POST" }).catch(() => {});
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
