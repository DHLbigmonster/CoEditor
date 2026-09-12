// 桌面版界面验收：首次引导（选择文件夹 / 先看示例）、引导只在第一次出现、以及「退出 CoEditor」
//
// 用户实测报过一个 bug：选完文件夹之后引导还在，得点「先看示例」才消失；
// 而且点「先看示例」只是本地隐藏，刷新一下又来。这里把两条路径都钉住。
//
// 用法: COEDITOR_CDP_HTTP=http://127.0.0.1:9334 node tools/test-desktop-shell-ui.mjs
import { openPage, sleep } from "./p0-harness.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(REPO, "dist", "CoEditor.app");
const SUPPORT = join(homedir(), "Library", "Application Support", "CoEditor");
const OUT = "/tmp/coeditor-p0/evidence";
const PICKED = "/tmp/coeditor-dsk/picked";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  console.log(`${state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};
const readOr = async (f, d = null) => { try { return (await readFile(f, "utf8")).trim(); } catch { return d; } };

/** 停掉所有实例、清空 Application Support，重新双击一次 —— 等价于「用户第一次打开」 */
async function freshLaunch() {
  const { stdout } = await run("bash", ["-lc", `pgrep -f "CoEditor.app/Contents/Resources/app/server.mjs" || true`]);
  for (const pid of stdout.split("\n").filter(Boolean)) await run("kill", [pid]).catch(() => {});
  await sleep(1200);
  await rm(SUPPORT, { recursive: true, force: true });
  await run("open", [APP]);
  for (let i = 0; i < 60; i += 1) {
    const p = await readOr(join(SUPPORT, "server.port"));
    if (p && (await fetch(`http://127.0.0.1:${p}/api/app/info`).then((r) => r.ok).catch(() => false))) return p;
    await sleep(300);
  }
  return null;
}
const infoOf = (port) => fetch(`http://127.0.0.1:${port}/api/app/info`).then((r) => r.json()).catch(() => null);
const overlayShown = (page) => page.eval(`return !!document.querySelector('.dsk-first')`);

await mkdir(OUT, { recursive: true });
await mkdir(PICKED, { recursive: true });
await writeFile(join(PICKED, "笔记.md"), "# 我自己选的文件夹\n\n这是用户自己目录里的文件。\n", "utf8");

try {
  /* ================= 路径一：点「先看示例」 ================= */
  let port = await freshLaunch();
  record("应用已启动（首次运行）", Boolean(port), port ? `端口 ${port}` : "没起来");
  if (!port) throw new Error("应用没起来");

  let page = await openPage(`http://127.0.0.1:${port}/`, { width: 1440, height: 900 });
  await sleep(1600);

  const shell = await page.eval(`
    const box = document.querySelector('.dsk-first');
    const quit = document.querySelector('.rail-foot .dsk-quit');
    return { overlay: !!box && !box.hidden,
      title: box ? (box.querySelector('h2') || {}).textContent : null,
      buttons: box ? [...box.querySelectorAll('[data-dsk]')].map(b => b.textContent.trim()) : [],
      quit: quit ? quit.textContent.trim() : null };`);
  record("首次打开出现引导", shell.overlay === true, JSON.stringify(shell).slice(0, 180));
  record("引导标题是给用户看的话", shell.title === "把修改意见留在文档上。", JSON.stringify(shell.title));
  record("主按钮是「选择文件夹」，旁边有「先看示例」", shell.buttons[0] === "选择文件夹" && shell.buttons.includes("先看示例"), shell.buttons.join(" / "));
  record("左下角有明确的「退出 CoEditor」", /退出 CoEditor/.test(shell.quit || ""), JSON.stringify(shell.quit));
  await page.shot(`${OUT}/desktop-first-run.png`);

  await page.eval(`[...document.querySelectorAll('[data-dsk]')].find(b => b.dataset.dsk === 'sample').click(); return 1;`);
  await sleep(700);
  record("点「先看示例」后引导关闭，示例文件在列表里",
    await page.eval(`const b=document.querySelector('.dsk-first'); return (!b || b.hidden) && document.querySelectorAll('#tree [data-path]').length > 0`), "");

  // 关键：刷新之后不能再弹回来
  await page.navigate(`http://127.0.0.1:${port}/`);
  await sleep(1800);
  record("点过「先看示例」后刷新，引导不再出现", (await overlayShown(page)) === false, "");

  /* ================= 路径二：选了文件夹 ================= */
  await page.close();
  port = await freshLaunch();
  record("重新以首次运行启动（第二条路径）", Boolean(port), port ? `端口 ${port}` : "没起来");
  if (!port) throw new Error("第二条路径没起来");
  page = await openPage(`http://127.0.0.1:${port}/`, { width: 1440, height: 900 });
  await sleep(1600);
  record("此时引导仍在（对照组）", (await overlayShown(page)) === true, "");

  // 模拟用户在原生选择器里选好目录之后的动作序列（原生弹窗本身无法自动化）
  const switched = await fetch(`http://127.0.0.1:${port}/api/vault`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: PICKED }),
  }).then((r) => r.json()).catch(() => null);
  record("切换到用户自己的文件夹成功", Boolean(switched && switched.ok), JSON.stringify(switched && { root: switched.root }).slice(0, 120));

  const afterPick = await infoOf(port);
  record("选了文件夹之后 firstRun 就不再为真", Boolean(afterPick) && afterPick.firstRun === false,
    JSON.stringify(afterPick && { firstRun: afterPick.firstRun, root: afterPick.root }).slice(0, 160));

  // 选完文件夹会 reload —— 这正是用户看到的「引导又回来了」
  await page.navigate(`http://127.0.0.1:${port}/`);
  await sleep(1800);
  const stillThere = await overlayShown(page);
  record("选完文件夹刷新后，引导不再出现（用户报的 bug）", stillThere === false, stillThere ? "引导又回来了" : "不再出现");
  const tree = await page.eval(`return document.querySelectorAll('#tree [data-path]').length`);
  record("刷新后看到的是用户自己文件夹里的文件", tree > 0, `文件数=${tree}`);
  await page.shot(`${OUT}/desktop-after-pick.png`);

  await page.close();
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
} finally {
  const p = await readOr(join(SUPPORT, "server.port"));
  if (p) await fetch(`http://127.0.0.1:${p}/api/app/quit`, { method: "POST" }).catch(() => {});
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
