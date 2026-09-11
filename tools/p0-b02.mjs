// B02 右栏点击：真实鼠标重复点击，检测「丢点击」与「拖选右栏文字却跳正文」
// 规格 §B02 要求：文字 / 空白 / 图标 / 操作按钮 分别测，重复 20 次不能丢点击。
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_B02_DOC || "研究设计-英文摘要.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });

const treeExpr = `const row = document.querySelector('[data-path="${DOC}"]');
  if (!row) return null; row.scrollIntoView({ block: 'center' });
  const r = row.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`;

/** 卡片内某选择器的矩形中心（用真实坐标点击） */
const rectOf = (selector) => page.eval(`const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null; const r = el.getBoundingClientRect();
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };`);

const selectedId = () => page.eval(`const el = document.querySelector('#cards .card.selected'); return el ? el.dataset.id : null;`);

/** 等滚动收敛再取样：centerOn 用的是 smooth 滚动，立刻取样会量到上一次的动画残尾 */
async function settleScroll() {
  let prev = -1;
  for (let i = 0; i < 30; i += 1) {
    const top = await page.eval(`return Math.round(document.querySelector('#viewport').scrollTop)`);
    if (top === prev) return top;
    prev = top;
    await sleep(180);
  }
  return prev;
}
const cardIds = () => page.eval(`return [...document.querySelectorAll('#cards .card')].map(c => c.dataset.id);`);

/** 在 PDF 上真实拖选一段并写意见，返回新卡片 id */
async function createCard(from, to, text) {
  await page.drag(from, to, { steps: 12 });
  const btn = await page.eval(`const b = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (!btn) throw new Error("选区工具条没出现");
  await page.clickAt(btn.x, btn.y);
  await sleep(250);
  await page.eval(`const t = document.querySelector('#composer-input'); t.focus(); return 1;`);
  await page.type(text);
  await sleep(1200);
  await page.eval(`document.querySelector('#composer-save').click(); return 1;`);
  await sleep(900);
  const ids = await cardIds();
  return ids[ids.length - 1];
}

try {
  await openDoc(page, DOC);
  await sleep(2500);

  const spans = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page[data-page="1"] .textLayer span')]
    .filter(s => (s.textContent || '').trim().length > 3)
    .slice(0, 90)
    .map(s => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(s => s.w > 20 && s.h > 6);`);

  // 建 3 张卡（按实际可用行数三等分取，避免样本行数不足时只建出 1 张）
  const step = Math.max(1, Math.floor(spans.length / 3));
  const picks = [0, step, step * 2].filter((i) => spans[i] && spans[i + 3]);
  const ids = [];
  for (const [n, i] of picks.entries()) {
    const a = spans[i];
    const b = spans[i + 3] || spans[i + 1];
    ids.push(await createCard(
      { x: a.x + 1, y: a.y + a.h / 2 },
      { x: b.x + b.w - 1, y: b.y + b.h / 2 },
      `B02 测试意见 ${n + 1}：这段需要再补一处来源说明。`,
    ));
  }
  record("真实鼠标建 3 张卡", ids.length === 3 && ids.every(Boolean), `ids=${ids.length}`);

  /* ---------- 1. 重复点击：不能丢点击 ---------- */
  let lost = 0;
  const clickLog = [];
  for (let round = 0; round < 20; round += 1) {
    const target = ids[round % ids.length];
    const rect = await page.eval(`const c = document.querySelector('#cards .card[data-id="${target}"]');
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });            // 右栏可能有很多卡，先滚进视野再量坐标
      const b = c.querySelector('.c-body') || c;
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.x + Math.min(30, r.width / 2)), y: Math.round(r.y + r.height / 2) };`);
    await sleep(120);
    if (!rect) { lost += 1; clickLog.push({ round, target, reason: "卡片不在 DOM" }); continue; }
    await page.clickAt(rect.x, rect.y);
    await sleep(160);
    const got = await selectedId();
    if (got !== target) {
      lost += 1;
      // 取证：是没选中，还是选到了别的卡，还是列表里根本没有卡
      const diag = await page.eval(`const cardsNow = document.querySelectorAll('#cards .card');
        const el = document.elementFromPoint(${rect.x}, ${rect.y});
        return { cards: cardsNow.length, selectedCount: document.querySelectorAll('#cards .card.selected').length,
                 hitClass: el ? String(el.className).slice(0, 40) : null,
                 hitCard: el && el.closest ? (el.closest('.card') || {}).dataset?.id ?? null : null,
                 selLen: String(window.getSelection() || '').trim().length };`).catch(() => ({}));
      clickLog.push({ round, target, got, diag, reason: "选中项不是被点的卡" });
    }
  }
  record("重复点击 20 次不丢点击", lost === 0, lost ? `${lost}/20 次异常 ${JSON.stringify(clickLog.slice(0, 4))}` : "20/20 命中");

  /* ---------- 2. 拖选卡片文字：不跳正文、不改选中 ---------- */
  const before = await selectedId();
  const scrollBefore = await settleScroll();
  const body = await page.eval(`const card = document.querySelector('#cards .card[data-id="${ids[0]}"]');
    if (card) card.scrollIntoView({ block: 'center' });
    const c = card.querySelector('.c-body');
    const r = c.getBoundingClientRect();
    return { x1: Math.round(r.x + 4), y1: Math.round(r.y + r.height / 2), x2: Math.round(r.right - 6), y2: Math.round(r.y + r.height / 2) };`);
  await page.drag({ x: body.x1, y: body.y1 }, { x: body.x2, y: body.y2 }, { steps: 8 });
  await sleep(500);
  const afterSel = await selectedId();
  const scrollAfter = await settleScroll();
  const menuOpen = await page.eval(`return !document.querySelector('#sel-menu').hidden`);
  record("拖选卡片文字不改变选中项", afterSel === before, `${before} → ${afterSel}`);
  record("拖选卡片文字不滚动正文", scrollAfter === scrollBefore, `scrollTop ${scrollBefore} → ${scrollAfter}`);
  record("拖选卡片文字不弹正文批注条", menuOpen === false, `sel-menu hidden=${!menuOpen}`);

  /* ---------- 3. 编辑：就地输入，不重建整列表 ---------- */
  const editRect = await page.eval(`const c = document.querySelector('#cards .card[data-id="${ids[1]}"]');
    if (!c) return null; c.scrollIntoView({ block: 'center' });
    const b = c.querySelector('button[data-act="edit"]');
    if (!b) return null; const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
  await sleep(150);
  if (editRect) {
    await page.clickAt(editRect.x, editRect.y);
    await sleep(400);
    const inPlace = await page.eval(`const c = document.querySelector('#cards .card[data-id="${ids[1]}"]');
      return { hasTextarea: !!c.querySelector('textarea'), sameCard: !!c };`);
    record("编辑按钮就地出现输入框（同一张卡内）", inPlace.hasTextarea && inPlace.sameCard, JSON.stringify(inPlace));
    // 退出编辑，避免影响后续
    await page.eval(`const b = document.querySelector('#cards .card[data-id="${ids[1]}"] button[data-act="cancel-edit"]'); if (b) b.click();
      const t = document.querySelector('#cards textarea'); if (t) t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 1;`);
    await sleep(600);
  } else {
    record("编辑按钮存在", false, "找不到 data-act=edit");
  }

  /* ---------- 4. 引用展开：只展开，不跳正文 ---------- */
  const selBeforeQuote = await selectedId();
  const quoteRect = await page.eval(`const card = document.querySelector('#cards .card[data-id="${ids[0]}"]');
    if (!card) return null; card.scrollIntoView({ block: 'center' });
    const c = card.querySelector('.c-quote');
    if (!c) return null; const r = c.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
  await sleep(150);
  const quoteOpenBefore = await page.eval(`return document.querySelector('#cards .card[data-id="${ids[0]}"]').classList.contains('quote-open')`);
  if (quoteRect) {
    await page.clickAt(quoteRect.x, quoteRect.y);
    await sleep(300);
    const quoteOpenAfter = await page.eval(`return document.querySelector('#cards .card[data-id="${ids[0]}"]').classList.contains('quote-open')`);
    record("点引用只切换展开状态", quoteOpenAfter !== quoteOpenBefore, `${quoteOpenBefore} → ${quoteOpenAfter}`);
    record("点引用不改变选中项", (await selectedId()) === selBeforeQuote);
  } else {
    record("引用元素存在", false, "找不到 .c-quote");
  }

  await page.shot(`${OUT}/b02-rail.png`);
  record("截图存档", true, `${OUT}/b02-rail.png`);
} catch (error) {
  record("执行中断", false, String(error?.message || error));
  try { await page.shot(`${OUT}/b02-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/b02.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const failed = log.filter((l) => !l.ok);
console.log(`\nPASS ${log.length - failed.length} / FAIL ${failed.length}（共 ${log.length} 项）`);
process.exit(failed.length ? 1 : 0);
