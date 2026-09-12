// 「未选择文档」空状态验收：居中盒子必须和纸张对齐，内容不得伸到纸张外面
//
// 用户报的现场：空状态页的三个步骤条「突出来」了 —— 量出来比纸张右边多出 165px。
// 用法: COEDITOR_CDP_HTTP=http://127.0.0.1:9335 COEDITOR_APP=http://127.0.0.1:4592/ node tools/test-empty-state.mjs
import { openPage, sleep } from "./p0-harness.mjs";
import { mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4592/";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  console.log(`${state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
await sleep(1500);

const measure = () => page.eval(`
  const r = (el) => { const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right), w: Math.round(b.width), h: Math.round(b.height) }; };
  const empty = document.querySelector('#empty');
  const paper = document.querySelector('#page');
  const steps = document.querySelector('.e-steps');
  const out = { shown: empty && getComputedStyle(empty).display !== 'none',
                paper: paper ? r(paper) : null, steps: steps ? r(steps) : null,
                stepsRect: empty ? r(empty) : null,
                stepItems: steps ? [...steps.children].map(r) : [] };
  if (out.paper && out.steps) {
    out.overflowRight = out.steps.right - out.paper.right;
    out.overflowLeft = out.paper.left - out.steps.left;
    out.centerDelta = Math.abs((out.steps.left + out.steps.right) / 2 - (out.paper.left + out.paper.right) / 2);
  }
  if (out.paper && out.stepsRect) {
    out.boxDeltaLeft = out.stepsRect.left - out.paper.left;
    out.boxDeltaWidth = out.stepsRect.w - out.paper.w;
  }
  const v = document.querySelector('#viewport');
  out.viewportOverflowX = Math.round(v.scrollWidth - v.clientWidth);
  return out;`);

try {
  // 走应用自己的代码路径显示空状态（切换目录后就是它把 #empty 打开）
  const shown = await page.eval(`try { resetDocView(); return document.querySelector('#empty').style.display !== 'none'; } catch (e) { return 'err:' + e.message; }`);
  record("空状态能显示（走 resetDocView 这条真实路径）", shown === true, String(shown));
  await sleep(600);

  const m = await measure();
  record("居中盒子与纸张左边缘对齐", Math.abs(m.boxDeltaLeft) <= 1, `左差=${m.boxDeltaLeft}px`);
  record("居中盒子与纸张同宽", Math.abs(m.boxDeltaWidth) <= 1, `宽差=${m.boxDeltaWidth}px`);
  record("三个步骤条不伸出纸张右边", m.overflowRight <= 1, `右溢出=${m.overflowRight}px（修前是 165）`);
  record("三个步骤条不伸出纸张左边", m.overflowLeft <= 1, `左溢出=${m.overflowLeft}px`);
  record("步骤条内容相对纸张居中", m.centerDelta <= 2, `中心偏差=${m.centerDelta}px`);
  record("步骤条是三个并排（不是掉行）", m.stepItems.length === 3 && new Set(m.stepItems.map((s) => s.h)).size === 1,
    `块数=${m.stepItems.length} 各高=${m.stepItems.map((s) => s.h).join(",")}`);
  record("没有把阅读容器撑出横向滚动", m.viewportOverflowX <= 1, `溢出=${m.viewportOverflowX}px`);
  console.log("  几何：", JSON.stringify({ paper: m.paper, steps: m.steps, 每个步骤: m.stepItems.map((s) => s.w) }));
  await page.shot(`${OUT}/empty-state-fixed.png`);

  // 窄窗口也要成立
  await page.setViewport(1024, 800);
  await sleep(900);
  await page.eval(`resetDocView(); return 1;`);
  await sleep(500);
  const n = await measure();
  record("1024px 下同样不伸出纸张", n.overflowRight <= 1 && n.overflowLeft <= 1, `左=${n.overflowLeft} 右=${n.overflowRight}`);
  await page.shot(`${OUT}/empty-state-1024.png`);
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
} finally {
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
