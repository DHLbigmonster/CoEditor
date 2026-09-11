// 远页高清：第一页放大 → 滚到后面的页 → 那些页必须按**当前倍率**画，且不被旧任务覆盖
// 判据：清晰 = 位图像素宽 ≈ 它当前的 CSS 宽 × dpr。若还按旧倍率画，位图会明显小于 CSS 尺寸（糊的）。
// 用法: node tools/p1-zoom-farpage.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_LONG_DOC || "长文档测试-12页.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

/** 每页的清晰度：位图像素宽 / (CSS 宽 × dpr)，≈1 才是「按当前倍率画」 */
const sharpness = (pageNo) => page.eval(`
  const p = document.querySelector('#doc .pdf-page[data-page="${pageNo}"]');
  if (!p) return null;
  const c = p.querySelector('canvas');
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const cssW = parseFloat(c.style.width) || 1;
  return { cssW: Math.round(cssW), bmpW: c.width, painted: c.dataset.painted || '', ratio: +(c.width / (cssW * dpr)).toFixed(3) };`);

const scrollTo = async (pageNo) => {
  await page.eval(`const p = document.querySelector('#doc .pdf-page[data-page="${pageNo}"]'); if (p) p.scrollIntoView({ block: 'center' }); return 1;`);
  let prev = -1;
  for (let i = 0; i < 30; i += 1) {
    const top = await page.eval(`return Math.round(document.querySelector('#viewport').scrollTop)`);
    if (top === prev) break;
    prev = top;
    await sleep(150);
  }
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
const errors = [];
page.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || "").slice(0, 160)); });

try {
  await openDoc(page, DOC);
  const pages = await page.eval(`return document.querySelectorAll('#doc .pdf-page').length`);
  record("长文档已打开（12 页）", pages >= 12, `页数=${pages}`);

  const base = await sharpness(1);
  record("100% 时首页清晰（位图 ≈ CSS 宽 × dpr）", base && Math.abs(base.ratio - 1) < 0.02, JSON.stringify(base));

  // 记住第 10 页在 100% 下的位图宽度：如果它还按旧倍率画，就会停在这个值附近
  const farAt100 = await sharpness(10);

  // ---- 放大到约 200% ----
  const box = await page.eval(`const r = document.querySelector('#viewport').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
  for (let i = 0; i < 20; i += 1) {
    const z = await page.eval(`return parseInt(document.querySelector('#zoom').textContent, 10) || 100`);
    if (z >= 195) break;
    await page.wheelZoom(box.x, box.y, -40);
    await sleep(90);
  }
  await sleep(2600);
  const zoomNow = await page.eval(`return parseInt(document.querySelector('#zoom').textContent, 10) || 100`);
  record("已放大到 ≈200%", zoomNow >= 190, `当前=${zoomNow}%`);

  const nearAfter = await sharpness(1);
  record("放大后可见页仍是清晰的（按新倍率重画）", nearAfter && Math.abs(nearAfter.ratio - 1) < 0.02 && nearAfter.bmpW > base.bmpW,
    `${JSON.stringify(base)} → ${JSON.stringify(nearAfter)}`);

  // ---- 滚到第 10 页：它此前从没进过视口，必须按当前倍率画 ----
  await scrollTo(10);
  let far = null;
  for (let i = 0; i < 40; i += 1) {
    far = await sharpness(10);
    if (far && far.painted === "1" && Math.abs(far.ratio - 1) < 0.02) break;
    await sleep(250);
  }
  record("滚到的远页按当前倍率绘制（不再沿用构建时的旧倍率）", far && Math.abs(far.ratio - 1) < 0.02,
    `100% 时位图=${farAt100 && farAt100.bmpW}px；现在 CSS=${far && far.cssW} 位图=${far && far.bmpW} 比值=${far && far.ratio} 放大=${zoomNow}%`);
  record("远页确实明显变清晰（位图比 100% 时大）", far && farAt100 && far.bmpW > farAt100.bmpW * 1.5,
    `${farAt100 && farAt100.bmpW}px → ${far && far.bmpW}px`);
  await page.shot(`${OUT}/zoom-farpage-10.png`);

  // ---- 旧任务不得覆盖新结果：静置后再验一次 ----
  await sleep(2200);
  const farSettled = await sharpness(10);
  const nearSettled = await sharpness(1);
  record("静置后远页清晰度不回退（旧任务没覆盖新结果）", farSettled && Math.abs(farSettled.ratio - 1) < 0.02 && farSettled.bmpW === far.bmpW,
    `${JSON.stringify(far)} → ${JSON.stringify(farSettled)}`);
  record("已滚走的页也没被降级/清空", nearSettled && Math.abs(nearSettled.ratio - 1) < 0.02,
    JSON.stringify(nearSettled));

  // ---- 再来一次：滚回第一页，再立刻快速缩到 100%，检查没有旧任务回写 ----
  await scrollTo(1);
  await page.eval(`document.querySelector('#zoom').click(); return 1;`); // 回到 100%
  await sleep(2600);
  const back100 = await sharpness(1);
  record("缩回 100% 后首页清晰度正确（无旧任务回写）", back100 && Math.abs(back100.ratio - 1) < 0.02,
    `${JSON.stringify(nearSettled)} → ${JSON.stringify(back100)}`);

  record("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  record("执行中断", false, String(error?.message || error));
  try { await page.shot(`${OUT}/p1-zoom-farpage-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/zoom-farpage.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const failed = log.filter((l) => !l.ok);
console.log(`\nPASS ${log.length - failed.length} / FAIL ${failed.length}（共 ${log.length} 项）`);
process.exit(failed.length ? 1 : 0);
