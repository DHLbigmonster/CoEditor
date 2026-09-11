// 拍 README / 社交预览要用的真实截图。只用合成样本，画面里不含任何真人信息。
// 用法: node tools/make-readme-shots.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = "研究设计-英文摘要.pdf";
const OUTDIR = "docs/screenshots";

await mkdir(OUTDIR, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
await openDoc(page, DOC);

// 建一条真实批注：截图里要有绿虚线和右侧意见卡
const spans = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page .textLayer span')]
  .filter(s => (s.textContent || '').trim().length > 8)
  .map(s => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
  .filter(s => s.w > 40 && s.h > 5).slice(0, 12);`);
// 挑一个粗体小标题来批注：缩略图尺寸下虚线也看得见
const head = await page.eval(`const one = [...document.querySelectorAll("#doc .pdf-page .textLayer span")]
  .find(s => /Variables|Identification/.test(s.textContent || ""));
  if (!one) return null; const r = one.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height };`);
const a = head || spans[3] || spans[0];
await page.drag({ x: a.x + 1, y: a.y + a.h / 2 }, { x: a.x + a.w - 1, y: a.y + a.h / 2 }, { steps: 10 });
const btn = await page.eval(`const b = document.querySelector('#sel-menu button[data-sel-act="comment"]');
  if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
if (btn) {
  await page.clickAt(btn.x, btn.y);
  await sleep(250);
  await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
  await page.type("这句结论需要一个实证例子，补上来源再定稿。");
  await sleep(1200);
  await page.eval(`const el = document.querySelector('#composer-save'); if (el) el.click(); return 1;`);
  await sleep(1400);
}

// 让正文与批注卡同屏：滚到批注所在位置
await page.eval(`const m = document.querySelector('#doc .pdf-text .anchor'); if (m) m.scrollIntoView({ block: 'center' }); return 1;`);
await sleep(900);
await page.shot(`${OUTDIR}/coeditor-reading.png`);
console.log("写出:", `${OUTDIR}/coeditor-reading.png`);

// 社交预览图：GitHub 推荐 1280×640
await page.setViewport(1280, 640);
await sleep(1800);
await page.eval(`const m = document.querySelector('#doc .pdf-text .anchor'); if (m) m.scrollIntoView({ block: 'center' }); return 1;`);
await sleep(1200);
await page.shot(`${OUTDIR}/social-preview.png`);
console.log("写出:", `${OUTDIR}/social-preview.png`);

await page.close();
