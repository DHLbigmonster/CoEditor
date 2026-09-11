// 规格 §3.2 / A19：1440 / 1100 / 900 / 760 四档宽度下的布局验收
// 判据只用可判定的量：横向溢出、三栏是否超出窗口、正文可用宽度、窄屏是否自动收起文件树。
// 用法: node tools/p1-responsive.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = "研究设计-英文摘要.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
await openDoc(page, DOC);

const snap = () => page.eval(`
  const vis = (sel) => { const el = document.querySelector(sel);
    if (!el || el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return 0;
    const r = el.getBoundingClientRect(); return r.width > 0 && r.right > 0 && r.left < window.innerWidth ? Math.round(r.width) : 0; };
  return {
    innerW: window.innerWidth,
    overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    railW: vis('#rail'),
    cardsW: vis('#cards'),
    viewportW: Math.round(document.querySelector('#viewport').getBoundingClientRect().width),
    railHidden: document.body.classList.contains('rail-hidden'),
    cardsHidden: document.body.classList.contains('cards-hidden'),
    docVisibleW: Math.round(document.querySelector('#doc').getBoundingClientRect().width),
    firstPageW: (() => { const p = document.querySelector('#doc .pdf-page'); return p ? Math.round(p.getBoundingClientRect().width) : 0; })(),
  };`);

try {
  for (const width of [1440, 1100, 900, 760]) {
    // 先回宽屏并把文件树展开，再切到目标宽度——否则「切窄后自动收起」会被测试自己又点开
    await page.setViewport(1440, 900);
    await page.eval(`if (document.body.classList.contains('rail-hidden')) document.querySelector('#rail-toggle').click(); return 1;`);
    await sleep(700);
    await page.setViewport(width, 900);
    await sleep(3200); // 视口变化后 PDF 会按新宽度重渲染，等它收敛
    const s = await snap();
    let offenders = [];
    if (s.overflowX > 1) {
      offenders = await page.eval(`
        const w = window.innerWidth;
        return [...document.querySelectorAll('body *')]
          .map(el => { const r = el.getBoundingClientRect();
            return { sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0,2).join('.') : ''),
                     right: Math.round(r.right), w: Math.round(r.width), pos: getComputedStyle(el).position }; })
          .filter(x => x.right > w + 1 && x.w > 0)
          .slice(0, 6);`);
    }
    record(`${width}px：无横向溢出`, s.overflowX <= 1, `overflowX=${s.overflowX}${offenders.length ? " 越界元素=" + JSON.stringify(offenders) : ""}`);
    record(`${width}px：三栏不超出窗口`, s.railW + s.cardsW + s.viewportW <= s.innerW + 2,
      `rail=${s.railW} cards=${s.cardsW} viewport=${s.viewportW} inner=${s.innerW}`);
    record(`${width}px：正文可用宽度 ≥ 320px`, s.viewportW >= 320, `viewport=${s.viewportW}`);
    record(`${width}px：PDF 页未被压成窄条（≥280px）`, s.firstPageW >= 280, `首页宽=${s.firstPageW}`);
    if (width < 1100) { // 规格写的是「窄于 1100px」，正好 1100 不触发
      record(`${width}px：窄屏下文件树应自动收起（规格 §3.2）`, s.railHidden === true, `railHidden=${s.railHidden} railW=${s.railW}`);
    }
    await page.shot(`${OUT}/p1-responsive-${width}.png`);
  }
} catch (error) {
  record("执行中断", false, String(error?.message || error));
} finally {
  await writeFile(`${OUT}/p1-responsive.json`, JSON.stringify({ at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const failed = log.filter((l) => !l.ok);
console.log(`\n结果：${log.length - failed.length}/${log.length} 通过`);
process.exit(failed.length ? 1 : 0);
