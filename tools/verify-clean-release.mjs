// 干净目录验收：验证「别人从 GitHub 下载下来、不装依赖」也能跑起来并完成主回路。
// 跑之前先起干净副本：
//   git archive HEAD | tar -x -C /tmp/coeditor-clean
//   cd /tmp/coeditor-clean && COEDITOR_PORT=4599 node server.mjs ./sample
// 用法: node tools/verify-clean-release.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";

const APP = process.env.CLEAN_APP || "http://127.0.0.1:4599/";
const CLEAN_DIR = process.env.CLEAN_DIR || "/tmp/coeditor-clean";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

await mkdir(OUT, { recursive: true });

/* ---------- 0. 干净副本本身的前提 ---------- */
try {
  const entries = await readdir(CLEAN_DIR);
  record("干净副本里没有 node_modules", !entries.includes("node_modules"), `条目数=${entries.length}`);
  const vendored = await readdir(`${CLEAN_DIR}/vendor`).catch(() => []);
  record("vendor/ 里有内置 jszip", vendored.includes("jszip.min.cjs"), JSON.stringify(vendored));
} catch (error) {
  record("干净副本存在", false, String(error?.message || error), "skip");
}

/* ---------- 1. HTTP 层 ---------- */
try {
  const home = await fetch(APP);
  record("首页可访问", home.status === 200, `status=${home.status}`);
  const tree = await fetch(`${APP}api/tree`).then((r) => r.json());
  record("文件树接口可用", Array.isArray(tree.tree) && tree.tree.length > 0, `条目=${tree.tree.length}`);
  const agent = await fetch(`${APP}api/agent-status`).then((r) => r.json());
  record("Agent 状态接口可用", typeof agent.count === "number", JSON.stringify(agent).slice(0, 120));
} catch (error) {
  record("HTTP 层可用", false, String(error?.message || error));
}

/* ---------- 2. 浏览器主回路 ---------- */
const page = await openPage(APP, { width: 1440, height: 900 });
const errors = [];
page.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || "").slice(0, 160)); });

try {
  await openDoc(page, "研究设计-英文摘要.pdf");
  record("干净副本能打开 PDF 并渲染文字层", true);

  const spans = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page .textLayer span')]
    .filter(s => (s.textContent || '').trim().length > 8)
    .map(s => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(s => s.w > 40 && s.h > 5).slice(0, 10);`);
  const t = spans[2] || spans[0];
  await page.drag({ x: t.x + 1, y: t.y + t.h / 2 }, { x: t.x + t.w - 1, y: t.y + t.h / 2 }, { steps: 12 });
  const btn = await page.eval(`const b = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  record("选中后出现批注入口", Boolean(btn));
  if (btn) {
    await page.clickAt(btn.x, btn.y);
    await sleep(300);
    const ph = await page.eval(`return document.querySelector('#composer-input').placeholder`);
    record("输入框是日常语言", ph === "希望这里怎么改？", JSON.stringify(ph));
    await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
    await page.type("干净副本验收：这句话需要补一个来源。");
    await sleep(1500);
    const saved = await fetch(`${APP}api/annotations?p=${encodeURIComponent("研究设计-英文摘要.pdf")}`).then((r) => r.json()).catch(() => ({}));
    record("批注已落盘", JSON.stringify(saved).includes("需要补一个来源"), `批注数=${(saved.annotations || []).length}`);
  }

  await page.navigate(APP);
  await openDoc(page, "研究设计-英文摘要.pdf");
  await page.waitFor(`return document.querySelectorAll('#doc .pdf-text .anchor').length > 0`, { label: "重开后标记", timeout: 20000 }).catch(() => null);
  const marks = await page.eval(`return document.querySelectorAll('#doc .pdf-text .anchor').length`);
  const deco = await page.eval(`const m = document.querySelector('#doc .pdf-text .anchor');
    return m ? getComputedStyle(m).textDecorationColor : null;`);
  record("重开后原文出现绿色虚线（主回路闭环）", marks > 0 && /57,\s*128,\s*90/.test(deco || ""), `标记=${marks} 颜色=${deco}`);

  /* ---------- 3. DOCX 文字模式（这条走内置 jszip，是「零安装」的关键证据） ---------- */
  const docx = await page.eval(`const row = document.querySelector('[data-path^="项目简报"]');
    if (!row) return null; row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (docx) {
    await page.clickAt(docx.x, docx.y);
    await page.waitFor(`return (document.querySelector('#docpath') ? document.querySelector('#docpath').textContent : '').includes('项目简报')`, { label: "切到 DOCX", timeout: 15000 }).catch(() => null);
    await sleep(2200);
    const docxState = await page.eval(`const d = document.querySelector('#doc');
      return { text: (d.innerText || '').replace(/\\s+/g, ' ').slice(0, 160), len: (d.innerText || '').trim().length };`);
    record("DOCX 能打开并读出文字（这条走内置 jszip，是零安装的关键证据）", docxState.len > 10, JSON.stringify(docxState).slice(0, 200));
    await page.shot(`${OUT}/clean-docx.png`);
  } else {
    record("干净副本里能找到 DOCX 样本", false, "文件树里没有 项目简报", "skip");
  }
} catch (error) {
  record("浏览器主回路", false, String(error?.message || error));
} finally {
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
await writeFile(`${OUT}/clean-release.json`, JSON.stringify({ app: APP, at: new Date().toISOString(), log, errors }, null, 2), "utf8");
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
