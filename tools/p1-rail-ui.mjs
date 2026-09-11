// 批注栏可编辑性验收：
//   1. 「⋯」菜单要像控件（指针 / 命中区 / 聚焦描边 / 打开后有面板），不是一段装饰文字
//   2. 卡片操作按钮默认可见，不靠悬停才冒出来
//   3. 状态徽章不重复渲染（stale 只出现一次「需确认位置」）
// 用法: COEDITOR_APP=http://127.0.0.1:4591/ node tools/p1-rail-ui.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { mkdir, writeFile } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4591/";
const DOC = process.env.COEDITOR_RAIL_DOC || "研究设计-英文摘要.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });

try {
  await openDoc(page, DOC);

  // 造一条批注 + 一条保留
  const spans = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page .textLayer span')]
    .filter(s => (s.textContent || '').trim().length > 10)
    .map(s => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(s => s.w > 60).slice(0, 10);`);
  const pick = (i) => spans[i] || spans[0];
  let t = pick(1);
  await page.drag({ x: t.x + 1, y: t.y + t.h / 2 }, { x: t.x + t.w - 1, y: t.y + t.h / 2 }, { steps: 10 });
  let b = await page.eval(`const el = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await page.clickAt(b.x, b.y);
  await sleep(300);
  await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
  await page.type("这里需要一个来源。");
  await sleep(1400);
  await page.eval(`const el = document.querySelector('#composer-save'); if (el) el.click(); return 1;`);
  await sleep(1000);

  t = pick(3);
  await page.drag({ x: t.x + 1, y: t.y + t.h / 2 }, { x: t.x + t.w - 1, y: t.y + t.h / 2 }, { steps: 10 });
  b = await page.eval(`const el = document.querySelector('#sel-menu button[data-sel-act="highlight"]');
    const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await page.clickAt(b.x, b.y);
  await sleep(900);

  // 通过 API 把其中一条置为 stale（status 是允许 PATCH 的字段）
  const list = await fetch(`${APP}api/annotations?p=${encodeURIComponent(DOC)}`).then((r) => r.json());
  const target = (list.annotations || []).find((a) => a.status === "active");
  if (target) {
    await fetch(`${APP}api/annotations?p=${encodeURIComponent(DOC)}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: target.id, status: "stale", event: "test-stale" }),
    });
  }
  await page.navigate(APP);
  await openDoc(page, DOC);
  await sleep(1200);

  /* ---------- 1. ⋯ 要像控件 ---------- */
  const more = await page.eval(`
    const s = document.querySelector('.tabs-more > summary');
    if (!s) return null;
    const cs = getComputedStyle(s);
    const r = s.getBoundingClientRect();
    return { cursor: cs.cursor, w: Math.round(r.width), h: Math.round(r.height),
             aria: s.getAttribute('aria-label'), title: s.getAttribute('title'), text: s.textContent.trim() };`);
  record("「⋯」是可点的（cursor: pointer）", more && more.cursor === "pointer", JSON.stringify(more));
  record("「⋯」有像样的命中区（≥24×24）", more && more.w >= 24 && more.h >= 24, more && `${more.w}×${more.h}`);
  record("「⋯」有可读的无障碍名字", Boolean(more && more.aria), more && more.aria);

  // 必须用真实 Tab 走过去：JS 的 .focus() 不会触发 :focus-visible，
  // 用程序化聚焦去断言焦点样式，量到的永远是 none（第一次就是这么误报的）
  let focus = { focused: false, outline: "none", presses: 0 };
  for (let i = 0; i < 240; i += 1) {
    await page.key("Tab", { code: "Tab", keyCode: 9 });
    const now = await page.eval(`
      const s = document.querySelector('.tabs-more > summary');
      const cs = getComputedStyle(s);
      return { onSummary: document.activeElement === s, outline: cs.outlineStyle, width: cs.outlineWidth };`);
    if (now.onSummary) { focus = { focused: true, outline: now.outline, width: now.width, presses: i + 1 }; break; }
  }
  record("「⋯」能用 Tab 键盘到达且有焦点可见性", focus.focused && focus.outline !== "none", JSON.stringify(focus));

  // 打开后要是一个有容器的面板，而不是三颗裸按钮
  await page.eval(`document.querySelector('.tabs-more > summary').click(); return 1;`);
  await sleep(350);
  const panel = await page.eval(`
    const d = document.querySelector('.tabs-more[open] > div');
    if (!d) return null;
    const cs = getComputedStyle(d); const r = d.getBoundingClientRect();
    return { bg: cs.backgroundColor, border: cs.borderTopWidth, shadow: cs.boxShadow !== 'none',
             w: Math.round(r.width), buttons: [...d.querySelectorAll('button')].map(b => b.textContent.trim()) };`);
  record("「⋯」打开后是有背景/边框/阴影的面板", Boolean(panel) && panel.border !== "0px" && panel.shadow,
    JSON.stringify(panel));
  record("面板里是三个分组入口", Boolean(panel) && panel.buttons.length === 3, panel && panel.buttons.join(" / "));
  await page.shot(`${OUT}/rail-more-open.png`);
  await page.eval(`document.querySelector('.tabs-more > summary').click(); return 1;`);
  await sleep(250);

  /* ---------- 2. 卡片操作默认可见 ---------- */
  const actions = await page.eval(`
    const a = document.querySelector('#cards .card .c-actions');
    if (!a) return null;
    const cs = getComputedStyle(a);
    return { opacity: cs.opacity, visibility: cs.visibility,
             buttons: [...a.querySelectorAll('button')].map(b => b.textContent.trim()) };`);
  record("卡片操作按钮默认就可见（不靠悬停）", actions && actions.opacity === "1" && actions.visibility === "visible",
    JSON.stringify(actions));
  record("按钮文字是给人看的", Boolean(actions) && actions.buttons.some((x) => /编辑|已处理|删除|取消保留|恢复/.test(x)),
    actions && actions.buttons.join(" / "));
  await page.shot(`${OUT}/rail-actions-visible.png`);

  /* ---------- 3. 状态徽章不重复 ---------- */
  const staleCard = await page.eval(`
    const card = [...document.querySelectorAll('#cards .card')].find(c => (c.textContent || '').includes('需确认位置'));
    if (!card) return null;
    const spans = [...card.querySelectorAll('.c-head > span')].map(s => s.textContent.trim()).filter(Boolean);
    return { badges: spans, count: spans.filter(t => t === '需确认位置').length, text: (card.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) };`);
  if (staleCard) {
    record("stale 卡片的「需确认位置」只出现一次", staleCard.count === 1, JSON.stringify(staleCard));
  } else {
    record("能构造出 stale 卡片（前置条件）", false, "没有找到带「需确认位置」的卡片", "skip");
  }
  await page.shot(`${OUT}/rail-stale-badge.png`);
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
} finally {
  await writeFile(`${OUT}/rail-ui.json`, JSON.stringify({ at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
