// 缩放平滑验收：不重建 DOM、同步响应、手势中心不漂、位图事后锐化、画布不闪白
// 做法对齐 PDF.js 官方 viewer（改 --scale-factor 与页面 CSS 尺寸，位图分辨率随后补齐）。
// 用法: node tools/p1-zoom-smooth.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_P1_DOC || "研究设计-技术附录.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
const errors = [];
page.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || "").slice(0, 160)); });

const state = () => page.eval(`
  const p = document.querySelector('#doc .pdf-page');
  const c = p ? p.querySelector('canvas') : null;
  const a = document.querySelector('#doc .pdf-text .anchor');
  const ar = a ? a.getBoundingClientRect() : null;
  return {
    wrapperW: p ? Math.round(p.getBoundingClientRect().width) : 0,
    canvasCssW: c ? Math.round(parseFloat(c.style.width)) : 0,
    canvasPxW: c ? c.width : 0,
    painted: c ? c.dataset.painted || '' : '',
    anchors: document.querySelectorAll('#doc .pdf-text .anchor').length,
    anchorY: ar ? Math.round(ar.y) : null,
    anchorX: ar ? Math.round(ar.x) : null,
    zoom: (document.querySelector('#zoom') || {}).textContent,
  };`);

try {
  await openDoc(page, DOC);
  // 在正文里放一条批注，用来验证「缩放期间批注不需要重新锚定」
  const spans = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page .textLayer span')]
    .filter(s => (s.textContent || '').trim().length > 3)
    .map(s => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(s => s.w > 20 && s.h > 5).slice(0, 12);`);
  const t = spans[2] || spans[0];
  await page.drag({ x: t.x + 1, y: t.y + t.h / 2 }, { x: t.x + t.w - 1, y: t.y + t.h / 2 }, { steps: 10 });
  const b = await page.eval(`const el = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (b) {
    await page.clickAt(b.x, b.y);
    await sleep(250);
    await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
    await page.type("缩放平滑验收用批注");
    await sleep(1200);
    await page.eval(`const el = document.querySelector('#composer-save'); if (el) el.click(); return 1;`);
    await sleep(900);
  }

  // DOM 重建计数
  await page.eval(`
    window.__mut = { added: 0, removed: 0, clears: 0 };
    new MutationObserver((records) => { for (const r of records) {
      window.__mut.added += r.addedNodes.length; window.__mut.removed += r.removedNodes.length;
      if (r.removedNodes.length >= 2 && r.addedNodes.length === 0) window.__mut.clears += 1; } })
      .observe(document.querySelector('#doc'), { childList: true, subtree: true });
    return 1;`);

  const before = await state();
  record("手势前：有批注标记、位图已画好", before.anchors > 0 && before.painted === "1" && before.canvasPxW > 0,
    JSON.stringify(before));

  const box = await page.eval(`const r = document.querySelector('#viewport').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);

  // ---- 1. 同步响应：一个事件之后，页面 CSS 尺寸必须已经变了（不是等几百毫秒）----
  await page.wheelZoom(box.x, box.y, -60);
  const immediate = await state();
  record("单次缩放事件后页面尺寸立刻变化（同步响应，无防抖等待）", immediate.wrapperW > before.wrapperW,
    `${before.wrapperW} → ${immediate.wrapperW}`);

  // ---- 2. 连续手势：中心点不漂、DOM 不重建 ----
  const anchorBefore = await page.eval(`const r = document.querySelector('#doc .pdf-page').getBoundingClientRect();
    return { page: 1, fx: (${box.x} - r.left) / r.width, fy: (${box.y} - r.top) / r.height };`);
  const drifts = [];
  for (let i = 0; i < 8; i += 1) {
    await page.wheelZoom(box.x, box.y, -14);
    await sleep(60);
    const d = await page.eval(`const p = document.querySelector('#doc .pdf-page[data-page="${anchorBefore.page}"]');
      const r = p.getBoundingClientRect();
      const px = r.left + ${anchorBefore.fx} * r.width, py = r.top + ${anchorBefore.fy} * r.height;
      return { dx: px - ${box.x}, dy: py - ${box.y} };`);
    drifts.push(Math.hypot(d.dx, d.dy));
  }
  const maxDrift = Math.max(...drifts);
  record("连续捏合中手势中心不漂（≤8px）", maxDrift <= 8, `各步漂移=${drifts.map((v) => v.toFixed(1)).join(",")} 最大=${maxDrift.toFixed(1)}px`);

  const mid = await state();
  record("手势中 DOM 未被清空重建", (await page.eval(`return window.__mut.clears`)) === 0 && (await page.eval(`return window.__mut.removed`)) === 0,
    JSON.stringify(await page.eval(`return window.__mut`)));
  record("手势中批注标记仍在（不需要重新锚定）", mid.anchors === before.anchors, `标记数 ${before.anchors} → ${mid.anchors}`);
  record("手势中画布不是白的（旧位图顶着）", mid.canvasPxW === before.canvasPxW && mid.painted === "1",
    `位图 ${before.canvasPxW} → ${mid.canvasPxW}px painted=${mid.painted}`);
  await page.shot(`${OUT}/zoom-midgesture.png`);

  // ---- 3. 收敛后位图锐化 ----
  await sleep(2600);
  const after = await state();
  record("收敛后位图按新倍率重画（分辨率提高）", after.canvasPxW > before.canvasPxW,
    `${before.canvasPxW} → ${after.canvasPxW}px，CSS 宽 ${before.canvasCssW} → ${after.canvasCssW}`);
  record("收敛后仍无 DOM 重建", (await page.eval(`return window.__mut.clears`)) === 0, JSON.stringify(await page.eval(`return window.__mut`)));
  record("收敛后批注标记数量不变", after.anchors === before.anchors, `${before.anchors} → ${after.anchors}`);

  // ---- 4. 对齐：位图尺寸与页面尺寸一致（锐化后不错位） ----
  const aligned = Math.abs(after.canvasCssW - after.wrapperW) <= 1;
  record("锐化后画布 CSS 宽 == 页面宽（无错位/拉伸残留）", aligned, `canvas=${after.canvasCssW} wrapper=${after.wrapperW}`);
  await page.shot(`${OUT}/zoom-settled.png`);

  record("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  record("执行中断", false, String(error?.message || error));
  try { await page.shot(`${OUT}/p1-zoom-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/zoom-smooth.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const failed = log.filter((l) => !l.ok);
console.log(`\nPASS ${log.length - failed.length} / FAIL ${failed.length}（共 ${log.length} 项）`);
process.exit(failed.length ? 1 : 0);
