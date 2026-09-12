// CoEditor.app 启动器验收：首次启动 / 重复启动 / 退出 / 错误提示
//
//   node tools/test-desktop-launcher.mjs
//
// 会真的启动 dist/CoEditor.app（会打开一次浏览器），结束时把服务停掉。
// 全程只用应用自己的 Application Support 目录，不碰任何真实工作区。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const APP = join(REPO, "dist", "CoEditor.app");
const SUPPORT = join(homedir(), "Library", "Application Support", "CoEditor");

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}` : ""}`);
};

const readOr = async (file, fallback = null) => {
  try { return (await readFile(file, "utf8")).trim(); } catch { return fallback; }
};
const alive = async (pid) => {
  if (!pid) return false;
  try { await run("kill", ["-0", String(pid)]); return true; } catch { return false; }
};
const portAnswers = async (port) => {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/app/info`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? await res.json() : null;
  } catch { return null; }
};
const waitFor = async (fn, ms = 20000, step = 150) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, step)); }
  return null;
};

try {
  await access(APP, constants.F_OK);
  record("CoEditor.app 存在", true, APP);

  // 从干净状态开始，模拟「第一次双击」
  await rm(SUPPORT, { recursive: true, force: true });

  /* ---------- 1. 首次启动 ---------- */
  await run("open", [APP]);
  const port = await waitFor(async () => {
    const p = await readOr(join(SUPPORT, "server.port"));
    return p && (await portAnswers(p)) ? p : null;
  }, 30000);
  record("首次双击：自动起服务并选了端口", Boolean(port), port ? `端口 ${port}` : "30 秒内没就绪");

  const info = port ? await portAnswers(port) : null;
  record("服务认自己是桌面模式", info && info.desktop === true, JSON.stringify(info));
  record("首次运行标记为 firstRun（界面据此出引导）", info && info.firstRun === true, info ? `firstRun=${info.firstRun}` : "-");
  record("首次运行落在自带示例目录（没有去翻用户目录）", Boolean(info && /Resources\/app\/sample$/.test(info.root)), info && info.root);

  const pid1 = await readOr(join(SUPPORT, "server.pid"));
  record("记录了服务进程号（供退出与重复启动判断）", Boolean(pid1) && (await alive(pid1)), `pid=${pid1}`);
  record("写日志文件（用户看不到终端窗口）", Boolean(await readOr(join(SUPPORT, "coeditor.log"))), "coeditor.log");

  /* ---------- 2. 重复双击 ---------- */
  await run("open", [APP]);
  await new Promise((r) => setTimeout(r, 2500));
  const pid2 = await readOr(join(SUPPORT, "server.pid"));
  const port2 = await readOr(join(SUPPORT, "server.port"));
  record("再次双击：不再起第二个服务（pid 不变）", pid1 === pid2 && port === port2, `pid ${pid1} → ${pid2}，端口 ${port} → ${port2}`);
  // 只应存在一个 CoEditor 服务进程。
  // 注意：这个环境里 ps 被禁止（"operation not permitted"），用它会数出 0 而误报——用 pgrep -f。
  const { stdout: pgOut } = await run("bash", ["-lc", `pgrep -f "CoEditor.app/Contents/Resources/app/server.mjs" | wc -l`]).catch(() => ({ stdout: "0" }));
  const procCount = Number(pgOut.trim());
  const { stdout: lsofOut } = await run("bash", ["-lc", `lsof -nP -iTCP:${port} -sTCP:LISTEN 2>/dev/null | tail -n +2 | wc -l`]).catch(() => ({ stdout: "0" }));
  const listeners = Number(lsofOut.trim());
  record("系统里只有一份 CoEditor 服务进程", procCount === 1 && listeners === 1,
    `进程数=${procCount} 端口监听者=${listeners}`);

  /* ---------- 3. 关掉网页不影响服务 ---------- */
  await new Promise((r) => setTimeout(r, 1200));
  record("（模拟关闭网页后）服务仍在运行", await alive(pid1), `pid=${pid1} 存活`);

  /* ---------- 4. 退出 ---------- */
  const quit = port ? await fetch(`http://127.0.0.1:${port}/api/app/quit`, { method: "POST" }).then((r) => r.json()).catch(() => null) : null;
  record("「退出 CoEditor」接口有响应", Boolean(quit && quit.ok), JSON.stringify(quit));
  const stopped = await waitFor(async () => !(await alive(pid1)), 10000, 200);
  record("退出后后台服务真的停了", Boolean(stopped), stopped ? "已停止" : "10 秒后仍在运行");
  const gone = await waitFor(async () => !(await portAnswers(port)), 6000, 200);
  record("端口已释放（不再响应）", Boolean(gone), `端口 ${port}`);

  /* ---------- 5. 退出后还能再打开 ---------- */
  await run("open", [APP]);
  const port3 = await waitFor(async () => {
    const p = await readOr(join(SUPPORT, "server.port"));
    return p && (await portAnswers(p)) ? p : null;
  }, 30000);
  record("退出之后再双击能重新启动", Boolean(port3), port3 ? `端口 ${port3}` : "没起来");
  const info3 = port3 ? await portAnswers(port3) : null;
  record("第二次启动不再是 firstRun（记住了上次的文件夹）", Boolean(info3) && info3.firstRun !== true,
    info3 ? `firstRun=${info3.firstRun} root=${info3.root}` : "-");

  // 收尾：把自己的服务停掉
  if (port3) await fetch(`http://127.0.0.1:${port3}/api/app/quit`, { method: "POST" }).catch(() => {});
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
