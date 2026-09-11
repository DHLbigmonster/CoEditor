// B03 触控板缩放：真实 ctrl+wheel（CDP 合成）逐事件验证
//   1. 缓慢捏合：单个事件不得再是固定 ×1.1 跳档
//   2. 手势中心锚点漂移 ≤ 8 CSS px
//   3. 边界自然夹紧（50% / 300%）
//   4. 侧栏滚动/普通滚动不改变文档倍率
// 说明：CDP 合成只作自动回归，真机触控板验收另记（规格 §B03 明确要求）。
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_B03_DOC || "研究设计-技术附录.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });

const readZoom = () => page.eval(`return parseFloat(document.querySelector('#zoom').textContent) / 100`);
const pointInfo = (x, y) => page.eval(`
  const vp = document.querySelector('#viewport');
  const vr = vp.getBoundingClientRect();
  const el = document.elementFromPoint(${x}, ${y});
  const pg = el && el.closest ? el.closest('.pdf-page') : null;
  if (!pg) return null;
  const pr = pg.getBoundingClientRect();
  return { page: Number(pg.dataset.page), fx: (${x} - pr.left) / pr.width, fy: (${y} - pr.top) / pr.height, vx: vr.left, vy: vr.top };`);

/** 把「同一个文档点」当前落在屏幕的哪里，与手势起点比较 */
async function driftOf(anchor, targetX, targetY) {
  return page.eval(`
    const pg = document.querySelector('#doc .pdf-page[data-page="${anchor.page}"]');
    if (!pg) return null;
    const pr = pg.getBoundingClientRect();
    const px = pr.left + ${anchor.fx} * pr.width;
    const py = pr.top + ${anchor.fy} * pr.height;
    return { dx: px - ${targetX}, dy: py - ${targetY} };`);
}

const wheel = (x, y, deltaY, deltaMode = 0) =>
  page.wheelZoom(x, y, deltaY, deltaMode);

/** 等 PDF 重渲染收敛（倍率与标记都稳定） */
async function settle() {
  let prev = "";
  for (let i = 0; i < 40; i += 1) {
    const snap = await page.eval(`return document.querySelector('#zoom').textContent + '|' + document.querySelectorAll('#doc .pdf-page').length + '|' + (document.querySelector('#doc .pdf-page canvas')?.style.width || '')`);
    if (snap === prev) return;
    prev = snap;
    await sleep(350);
  }
}

try {
  await openDoc(page, DOC);
  await settle();

  const box = await page.eval(`const r = document.querySelector('#viewport').getBoundingClientRect();
    return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };`);

  /* ---------- 1. 缓慢捏合：不该出现固定 1.1 跳档 ---------- */
  await page.eval(`document.querySelector('#zoom').click()`); // 回到 100%
  await settle();
  const z0 = await readZoom();
  const slowSteps = [];
  for (let i = 0; i < 8; i += 1) {
    await wheel(box.x, box.y, -14);
    await sleep(45);
    slowSteps.push(await readZoom());
  }
  const perEvent = slowSteps.map((z, i) => +(z / (i ? slowSteps[i - 1] : z0)).toFixed(4));
  const maxStep = Math.max(...perEvent);
  // 旧实现是固定 ×1.1/事件（与手势幅度无关）。现在要求：单事件明显小于 1.1，且随幅度成比例。
  record("缓慢捏合不跳档（单事件倍率 < 1.10 且非固定值）", maxStep < 1.10, `单事件倍率=${JSON.stringify(perEvent)} 最大=${maxStep}`);

  // 幅度成比例：大 delta 的单事件步长必须明显大于小 delta
  const zSmallBefore = await readZoom();
  await wheel(box.x, box.y, -14);
  await sleep(120);
  const smallStep = (await readZoom()) / zSmallBefore;
  const zBigBefore = await readZoom();
  await wheel(box.x, box.y, -84);
  await sleep(120);
  const bigStep = (await readZoom()) / zBigBefore;
  // 缩放是乘性的，比较对数步长才对等：旧实现两档完全一样
  const logRatio = Math.log(bigStep) / Math.log(smallStep);
  record("倍率随手势幅度变化（不是固定倍率按钮）", logRatio > 1.5, `小幅度=${smallStep.toFixed(3)} 大幅度=${bigStep.toFixed(3)} 对数比=${logRatio.toFixed(2)}`);

  await settle();
  const z1 = await readZoom();
  record("缓慢捏合有渐进效果（整体确实放大）", z1 > z0, `${z0} → ${z1}`);

  /* ---------- 2. 锚点漂移 ---------- */
  const anchor = await pointInfo(box.x, box.y);
  await wheel(box.x, box.y, -260); // 一次性较快捏合
  await settle();
  const drift = anchor ? await driftOf(anchor, box.x, box.y) : null;
  const driftPx = drift ? Math.hypot(drift.dx, drift.dy) : Infinity;
  record("手势中心锚点漂移 ≤ 8px", driftPx <= 8, drift ? `dx=${drift.dx.toFixed(1)} dy=${drift.dy.toFixed(1)}` : "取不到锚点");
  await page.shot(`${OUT}/b03-after-pinch.png`);

  /* ---------- 3. 边界夹紧 ---------- */
  for (let i = 0; i < 30; i += 1) await wheel(box.x, box.y, -300);
  await settle();
  const zMax = await readZoom();
  record("上限夹紧 300%", Math.abs(zMax - 3) < 0.001, `实际=${zMax}`);
  for (let i = 0; i < 40; i += 1) await wheel(box.x, box.y, 300);
  await settle();
  const zMin = await readZoom();
  record("下限夹紧 50%", Math.abs(zMin - 0.5) < 0.001, `实际=${zMin}`);

  /* ---------- 4. 普通滚动不改倍率 ---------- */
  await page.eval(`document.querySelector('#zoom').click()`);
  await settle();
  const zBefore = await readZoom();
  await page.scrollGesture(box.x, box.y, 300);
  await sleep(800);
  const zAfter = await readZoom();
  record("普通双指滚动不改变倍率", zBefore === zAfter, `${zBefore} → ${zAfter}`);

  // CDP 合成的滚动推不动这个环境下的 compositor（直接赋值 scrollTop 有效，说明容器可滚），
  // 所以这里改测真正能判定产品行为的一点：普通 wheel 有没有被我们抢掉。defaultPrevented=false = 交给原生滚动。
  const prevented = await page.eval(`const vp = document.querySelector("#viewport");
    const ev = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    vp.dispatchEvent(ev);
    return ev.defaultPrevented;`);
  record("普通滚动不被拦截（交给原生滚动）", prevented === false, `defaultPrevented=${prevented}`);

  /* ---------- 5. 侧栏滚动不影响文档 ---------- */
  const zSide = await readZoom();
  const railRect = await page.eval(`const r = document.querySelector('#rail').getBoundingClientRect(); return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) };`);
  await page.wheelZoom(railRect.x, railRect.y, -120);
  await sleep(500);
  const zSideAfter = await readZoom();
  record("侧栏上的滚轮不改变文档倍率", zSide === zSideAfter, `${zSide} → ${zSideAfter}`);
} catch (error) {
  record("执行中断", false, String(error?.message || error));
  try { await page.shot(`${OUT}/b03-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/b03.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const failed = log.filter((l) => !l.ok);
console.log(`\nPASS ${log.length - failed.length} / FAIL ${failed.length}（共 ${log.length} 项）`);
process.exit(failed.length ? 1 : 0);
