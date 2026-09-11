// 适合宽度：内部阅读容器的横向溢出矩阵（760 / 900 / 1440 × 反馈栏 开 / 关）
//
// 判据用的是 scrollWidth - clientWidth（真实内容溢出），与滚动条是否可见无关
// —— 不靠把滚动条藏起来通过。
// 用法: node tools/p1-fit-width.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_FIT_DOC || "研究设计-技术附录.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, ok: state === "pass", detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

const measure = () => page.eval(`
  const vp = document.querySelector('#viewport');
  const pg = document.querySelector('#doc .pdf-page');
  const cards = document.querySelector('#cards');
  const vis = (el) => el && el.offsetParent !== null;
  return {
    inner: window.innerWidth,
    htmlClient: document.documentElement.clientWidth,
    htmlScroll: document.documentElement.scrollWidth,
    bodyClient: document.body.clientWidth,
    bodyScroll: document.body.scrollWidth,
    scrollingEl: document.scrollingElement === document.documentElement ? 'html' : 'body',
    bodyChildren: [...document.body.children].map((el) => ({ t: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
      w: Math.round(el.getBoundingClientRect().width), r: Math.round(el.getBoundingClientRect().right),
      ox: getComputedStyle(el).overflowX, pos: getComputedStyle(el).position })),
    selfOverflow: [...document.querySelectorAll('body *')].filter((el) => el.scrollWidth > el.clientWidth + 1
      && getComputedStyle(el).overflowX !== 'auto' && getComputedStyle(el).overflowX !== 'scroll' && getComputedStyle(el).overflowX !== 'hidden')
      .map((el) => ({ t: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), sw: el.scrollWidth, cw: el.clientWidth, ox: getComputedStyle(el).overflowX })).slice(0, 5),
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
    vpClient: Math.round(vp.clientWidth),
    vpScroll: Math.round(vp.scrollWidth),
    vpOverflow: Math.round(vp.scrollWidth - vp.clientWidth),
    pageW: pg ? Math.round(pg.getBoundingClientRect().width) : 0,
    docClient: Math.round(document.querySelector('#doc').clientWidth),
    docPadL: Math.round(parseFloat(getComputedStyle(document.querySelector('#doc')).paddingLeft) || 0),
    docPadR: Math.round(parseFloat(getComputedStyle(document.querySelector('#doc')).paddingRight) || 0),
    worldW: Math.round(document.querySelector('#world').getBoundingClientRect().width),
    pageElW: Math.round(document.querySelector('#page').getBoundingClientRect().width),
    zoom: document.querySelector('#zoom').textContent,
    cardsShown: vis(cards) ? Math.round(cards.getBoundingClientRect().width) : 0,
    cardsHiddenClass: document.body.classList.contains('cards-hidden'),
  };`);

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });

/** 反馈栏开/关（走真实入口按钮） */
async function setCards(open) {
  await page.eval(`const hidden = document.body.classList.contains('cards-hidden');
    const btn = document.querySelector('#btn-cards');
    if (btn && hidden === ${open}) btn.click();
    return 1;`);
  await sleep(500);
}

try {
  await openDoc(page, DOC);

  for (const width of [760, 900, 1440]) {
    for (const cardsOpen of [false, true]) {
      await page.setViewport(width, 900);
      await sleep(400);
      await setCards(cardsOpen);
      // 回到适合宽度（100%），并等 PDF 按新容器宽重排
      await page.eval(`document.querySelector('#zoom').click(); return 1;`);
      await sleep(2600);

      const m = await measure();
      const label = `${width}px · 反馈栏${cardsOpen ? "开" : "关"}`;
      record(`${label}：内部阅读容器无横向溢出`, m.vpOverflow <= 1,
        `viewport ${m.vpScroll}/${m.vpClient} 溢出=${m.vpOverflow}；doc=${m.docClient}(pad ${m.docPadL}+${m.docPadR}) world=${m.worldW} pageEl=${m.pageElW} 页宽=${m.pageW}`);
      record(`${label}：PDF 页宽不超过容器`, m.pageW <= m.vpClient + 1, `页宽=${m.pageW} 容器=${m.vpClient}`);
      let offenders = [];
      if (m.docOverflow > 1) {
        offenders = await page.eval(`
          const w = window.innerWidth;
          return [...document.querySelectorAll('body *')]
            .map((el) => { const r = el.getBoundingClientRect();
              return { sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : ''),
                       right: Math.round(r.right), w: Math.round(r.width), pos: getComputedStyle(el).position,
                       ox: getComputedStyle(el).overflowX }; })
            .filter((x) => x.right > w + 1 && x.w > 0).slice(0, 5);`);
      }
      record(`${label}：文档级无横向溢出`, m.docOverflow <= 1,
        `doc=${m.docOverflow} body=${m.bodyOverflow} 缩放=${m.zoom}` +
        (m.docOverflow > 1 ? ` inner=${m.inner} html=${m.htmlScroll}/${m.htmlClient} body=${m.bodyScroll}/${m.bodyClient} scrollEl=${m.scrollingEl} 子元素=${JSON.stringify(m.bodyChildren)} 自身溢出=${JSON.stringify(m.selfOverflow)}` : ""));
      // 规格 §3.2：<1180px 时反馈栏改走抽屉，不再是布局列——所以只在宽屏校验它作为列的存在性
      if (cardsOpen && width >= 1180 && m.cardsShown === 0) record(`${label}：反馈栏确实处于展开态`, false, `cardsHidden=${m.cardsHiddenClass}`);
      await page.shot(`${OUT}/fit-${width}-cards${cardsOpen ? "on" : "off"}.png`);
    }
  }
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
} finally {
  await writeFile(`${OUT}/fit-width.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}`);
process.exit(fail ? 1 : 0);
