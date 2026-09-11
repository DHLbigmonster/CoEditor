// A07 侧栏可调宽/可收起 · A08 IME 组合输入 · A09 保存失败与恢复
// 用法: node tools/p1-a07-a09.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_P1_DOC || "研究设计-英文摘要.pdf";
const OUT = "/tmp/coeditor-p0/evidence";
const API = "/api/annotations";

const log = [];
// 三态：PASS / FAIL / SKIP（SKIP = 前置条件不足，产品行为未被验证，既不算通过也不算失败）
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
const errors = [];
page.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || "").slice(0, 180)); });

const cssVar = (name) => page.eval(`return parseInt(getComputedStyle(document.documentElement).getPropertyValue('${name}')) || 0`);
const boxOf = (sel) => page.eval(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null;
  const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };`);
const settleScroll = async () => {
  let prev = -1;
  for (let i = 0; i < 30; i += 1) {
    const top = await page.eval(`return Math.round(document.querySelector('#viewport').scrollTop)`);
    if (top === prev) return top;
    prev = top;
    await sleep(150);
  }
  return prev;
};

/** 拖某个手柄到指定 clientX（真实鼠标）。
    分隔条是零宽元素 + 溢出伪元素做热区，所以不能按「元素中心」按下去——
    要用 elementFromPoint 在附近找出真正命中它的那一点。 */
async function dragHandle(sel, toX, { yOffset = 0 } = {}) {
  const b = await boxOf(sel);
  if (!b) return false;
  const y = Math.round(b.y + b.h / 2 + yOffset);
  const point = await page.eval(`
    for (let dx = -10; dx <= 4; dx += 2) {
      const el = document.elementFromPoint(${b.x} + dx, ${y});
      if (el && el.id === ${JSON.stringify(sel.replace("#", ""))}) return { x: ${b.x} + dx, y: ${y} };
    }
    return null;`);
  if (!point) return false;
  await page.drag({ x: point.x, y: point.y }, { x: toX, y: point.y }, { steps: 10 });
  await sleep(250);
  return true;
}

try {
  await openDoc(page, DOC);
  // 批注栏默认收起，先按真实入口打开，否则量不到宽度
  await page.eval(`const b = document.querySelector("#btn-cards");
    if (b && document.body.classList.contains("cards-hidden")) b.click();
    return 1;`);
  await sleep(400);

  /* ============ A07 侧栏调宽与收起 ============ */
  const rail0 = await boxOf("#rail");
  const cards0 = await boxOf("#cards");
  record("左右栏都在（文件树 + 批注栏）", Boolean(rail0) && Boolean(cards0), `rail=${rail0 && rail0.w} cards=${cards0 && cards0.w}`);

  // 文件树：拖到极左/极右，看夹紧区间
  await dragHandle("#rail-resizer", 40);
  const railMin = await boxOf("#rail");
  await dragHandle("#rail-resizer", 700);
  const railMax = await boxOf("#rail");
  record("文件树宽度夹紧在 180–320（规格 §3.2）", railMin.w >= 170 && railMin.w <= 190 && railMax.w >= 310 && railMax.w <= 330,
    `最小=${railMin.w} 最大=${railMax.w}`);

  // 批注栏：拖到极左/极右
  const main = await boxOf("#main");
  // 拖到「刚过收起阈值」位置量最小宽，拖到极左量最大宽（拖到极右是收起，不是最小宽）
  await dragHandle("#cards-resizer", main.right - 230);
  const cardsMin = await boxOf("#cards");
  await dragHandle("#cards-resizer", main.right - 900);
  const cardsMax = await boxOf("#cards");
  record("批注栏宽度夹紧在 240–400（规格 §3.2）", cardsMin.w >= 230 && cardsMin.w <= 250 && cardsMax.w >= 390 && cardsMax.w <= 410,
    `最小=${cardsMin.w} 最大=${cardsMax.w}`);

  // 横向溢出
  const overflow = await page.eval(`return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
    bodySw: document.body.scrollWidth };`);
  record("调宽后没有横向溢出", overflow.sw <= overflow.cw + 1, JSON.stringify(overflow));

  // 收起文件树：正文不应跳回顶部
  await page.eval(`document.querySelector('#viewport').scrollTop = 300; return 1;`);
  await sleep(200);
  const beforeCollapse = await page.eval(`return Math.round(document.querySelector('#viewport').scrollTop)`);
  await page.eval(`document.querySelector('#rail-toggle').click(); return 1;`);
  await sleep(400);
  const railHidden = await page.eval(`return document.body.classList.contains('rail-hidden')`);
  const afterCollapse = await page.eval(`return Math.round(document.querySelector('#viewport').scrollTop)`);
  record("文件树可收起", railHidden, `rail-hidden=${railHidden}`);
  record("收起后正文不跳到顶部（保持阅读位置）", Math.abs(afterCollapse - beforeCollapse) <= 40, `scrollTop ${beforeCollapse} → ${afterCollapse}`);
  await page.shot(`${OUT}/a07-narrow.png`);

  // 重新载入：宽度应被记住
  const railSaved = await boxOf("#rail");
  await page.navigate(APP);
  await openDoc(page, DOC);
  await sleep(600);
  const railRestored = await boxOf("#rail");
  record("宽度在工作区偏好中记忆（刷新后恢复）", Math.abs(railRestored.w - railSaved.w) <= 2, `${railSaved.w} → ${railRestored.w}`);

  /* ============ A08 IME 组合输入 ============ */
  await page.eval(`document.querySelector('#rail-toggle').click(); return 1;`); // 展开回文件树
  await sleep(300);
  await page.eval(`const r = document.querySelector('#cards-resizer'); return 1;`);

  const spans = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page .textLayer span')]
    .filter(s => (s.textContent || '').trim().length > 3)
    .map(s => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(s => s.w > 20 && s.h > 5).slice(0, 12);`);
  const target = spans[1] || spans[0];
  await page.drag({ x: target.x + 1, y: target.y + target.h / 2 }, { x: target.x + target.w - 1, y: target.y + target.h / 2 }, { steps: 10 });
  const btn = await page.eval(`const b = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await page.clickAt(btn.x, btn.y);
  await sleep(250);
  await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);

  page.clearRequests();
  // 计组合事件：用来区分「浏览器压根没进组合态（前置条件不足）」和「进了组合态却没落盘（真失败）」
  await page.eval(`window.__comp = { start: 0, update: 0, end: 0 };
    const i = document.querySelector('#composer-input');
    i.addEventListener('compositionstart', () => { window.__comp.start += 1; });
    i.addEventListener('compositionupdate', () => { window.__comp.update += 1; });
    i.addEventListener('compositionend', () => { window.__comp.end += 1; });
    return 1;`);
  // 组合期间：只发 composition，不发提交
  await page.imeCompose("这");
  await sleep(500);
  await page.imeCompose("这段");
  await sleep(700);
  const during = page.requestsTo(API, "POST").length;
  const compDuring = await page.eval(`return window.__comp`);
  await page.imeCommit("这段");
  await sleep(1600);
  const afterCommit = page.requestsTo(API, "POST").length;
  const composed = await page.eval(`return document.querySelector('#composer-input').value`);
  const compAfter = await page.eval(`return window.__comp`);

  if (compAfter.start === 0) {
    record("IME 组合期间不提交", false, `浏览器未进入组合态（compositionstart=0），本次未验证到产品行为`, "skip");
    record("组合结束后只提交一次", false, `同上：组合未生效`, "skip");
    record("组合文本正确落入输入框", false, `同上：组合未生效`, "skip");
  } else {
    record("IME 组合期间不提交", during === 0, `组合期间 POST=${during}；组合事件=${JSON.stringify(compDuring)}`);
    record("组合结束后只提交一次", afterCommit === 1, `结束后 POST=${afterCommit}；组合事件=${JSON.stringify(compAfter)}；输入框值=${JSON.stringify(composed.slice(0, 20))}`);
    record("组合文本正确落入输入框", composed.includes("这段"), JSON.stringify(composed.slice(0, 30)));
  }

  // 组合中切走文件：不得落盘半成品
  page.clearRequests();
  await page.imeCompose("另外一段");
  await sleep(300);
  const treeOther = await page.eval(`const row = document.querySelector('[data-path="研究设计-技术附录.pdf"]');
    if (!row) return null; row.scrollIntoView({ block: 'center' }); const r = row.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  await page.clickAt(treeOther.x, treeOther.y);
  await sleep(1200);
  const crossFile = page.requestsTo(API, "POST").length;
  record("组合中切换文件不提交半成品", crossFile === 0, `切文件后 POST=${crossFile}`);

  /* ============ A09 保存失败与恢复 ============ */
  await openDoc(page, DOC);
  await page.blockUrls([`*${API}*`]); // 让批注接口全部失败
  const beforeFail = await page.eval(`return document.querySelectorAll('#cards .card').length`);
  const spans2 = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page .textLayer span')]
    .filter(s => (s.textContent || '').trim().length > 3)
    .map(s => { const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(s => s.w > 20 && s.h > 5).slice(0, 12);`);
  const t2 = spans2[3] || spans2[1];
  await page.drag({ x: t2.x + 1, y: t2.y + t2.h / 2 }, { x: t2.x + t2.w - 1, y: t2.y + t2.h / 2 }, { steps: 10 });
  const btn2 = await page.eval(`const b = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (btn2) {
    await page.clickAt(btn2.x, btn2.y);
    await sleep(250);
    await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
    await page.type("A09 这条意见在接口失败时不能谎报已保存。");
    await sleep(3000); // 等防抖 + 失败返回
    const state = await page.eval(`const st = document.querySelector('#composer-status') || document.querySelector('#composer .c-tip');
      const badge = document.querySelector('#save-badge');
      const ta = document.querySelector('#composer-input');
      return { status: st ? st.textContent.trim() : null, badge: badge ? badge.textContent.trim() : null,
               composerOpen: !document.querySelector('#composer').hidden,
               keepText: ta ? ta.value.includes('不能谎报') : false };`);
    const honest = /失败|未保存|重试/.test(`${state.status} ${state.badge}`);
    record("保存失败时明确提示（不谎报已保存）", honest, JSON.stringify(state));
    record("失败后输入内容保留可重试", state.keepText === true, `keepText=${state.keepText}`);
    const cardsAfterFail = await page.eval(`return document.querySelectorAll('#cards .card').length`);
    record("失败时不产生半成品批注", cardsAfterFail === beforeFail, `${beforeFail} → ${cardsAfterFail}`);

    // 恢复：解除封锁后重试
    await page.blockUrls([]);
    await page.eval(`const b = document.querySelector('#composer-save'); if (b) b.click(); return 1;`);
    await sleep(1500);
    const cardsRecovered = await page.eval(`return document.querySelectorAll('#cards .card').length`);
    record("解除后重试成功落盘", cardsRecovered > beforeFail, `${beforeFail} → ${cardsRecovered}`);

    await page.navigate(APP);
    await openDoc(page, DOC);
    await sleep(900);
    const persisted = await page.eval(`return [...document.querySelectorAll('#cards .card')].some(c => (c.textContent || '').includes('不能谎报'))`);
    record("刷新后失败重试的意见仍在（真的落盘）", persisted === true, `persisted=${persisted}`);
  } else {
    record("A09：选区工具条可用", false, "点批注按钮没拿到坐标");
  }
  await page.shot(`${OUT}/a09-fail.png`);

  record("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  record("执行中断", false, String(error?.message || error));
  try { await page.shot(`${OUT}/p1-a07a09-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/a07-a09.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
