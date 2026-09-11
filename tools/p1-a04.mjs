// A04 / A03：重复句、特殊空白、跨页、旋转页、原文整段替换
// 全部走真实鼠标拖选 + 真实落盘 + 重开后几何核对。
// 用法: node tools/p1-a04.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir, copyFile } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = "A04-定位验收样本.pdf";
const VAULT = "/private/tmp/coeditor-p0/vault";
const FIX = "/tmp/coeditor-p0/fixtures";
const OUT = "/tmp/coeditor-p0/evidence";

const DUP_HEAD = "Quarterly observations are sampled by city tier";
const WS_HEAD = "Whitespace check";
const TAIL = "Tail paragraph on the second page";

/* 三态统计：PASS / FAIL / SKIP。
   SKIP 专指「测试前置条件没满足，产品行为未被验证」——它既不是通过，也不能算产品失败。
   旧写法把这类结果记成 true（=通过），等于用没跑成的用例凑通过率。 */
const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 260)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
await copyFile(`${FIX}/A04.a.pdf`, `${VAULT}/${DOC}`); // 每次从 A 版起跑

const page = await openPage(APP, { width: 1440, height: 900 });
const errors = [];
page.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || "").slice(0, 200)); });

/* ------------------------------ 通用工具 ------------------------------ */

async function settleScroll() {
  let prev = -1;
  for (let i = 0; i < 30; i += 1) {
    const top = await page.eval(`return Math.round(document.querySelector('#viewport').scrollTop)`);
    if (top === prev) return top;
    prev = top;
    await sleep(160);
  }
  return prev;
}

/** 把第 n 页滚进视野——不滚的话目标坐标在视口外，真实拖选会落空 */
async function focusPage(n) {
  await page.eval(`const pg = document.querySelector('#doc .pdf-page[data-page="${n}"]'); if (pg) pg.scrollIntoView({ block: 'center' }); return 1;`);
  await settleScroll();
  await sleep(250);
}

/** 第 n 页里所有「行组」（同一条文本行内的 span 按 x 合并） */
const LINE_GROUPS = `(n) => {
  const pg = document.querySelector('#doc .pdf-page[data-page="' + n + '"]');
  if (!pg) return null;
  const spans = [...pg.querySelectorAll('.textLayer span')].map(s => { const r = s.getBoundingClientRect();
    return { t: s.textContent, x: r.x, y: r.y, w: r.width, h: r.height }; })
    .filter(s => s.t && s.t.trim().length && s.w > 2 && s.h > 2);
  const groups = new Map();
  for (const s of spans) { const key = Math.round(s.y / 4); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(s); }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list.sort((a, b) => a.x - b.x));
}`;

const rectOfList = `(list) => { const a = list[0], b = list[list.length - 1];
  return { from: { x: a.x + 1, y: a.y + a.h / 2 }, to: { x: b.x + b.w - 1, y: b.y + b.h / 2 }, joined: list.map(s => s.t).join('') }; }`;

/** 第 occurrence 个包含 needle 的行组（occurrence 从 0 起） */
const lineTarget = (needle, n, occurrence = 0) => page.eval(`
  const groups = (${LINE_GROUPS})(${n});
  if (!groups) return null;
  const hits = groups.filter(list => list.map(s => s.t).join('').includes(${JSON.stringify(needle)}));
  const list = hits[${occurrence}];
  if (!list) return null;
  return (${rectOfList})(list);`);

/** 第 n 页「视口内」最靠下 / 最靠上的行组——必须可见，否则按下去等于点在窗口外 */
const visibleLine = (n, which) => {
  // 注意：选择哪一项必须在 Node 侧先算成「页面源码字符串」，不能在 ${} 里直接写 inside[...]，
  // 那是 Node 的变量作用域（第一次写成那样直接 ReferenceError）
  const pick = which === "last" ? "inside[inside.length - 1]" : "inside[0]";
  return page.eval(`
  const groups = (${LINE_GROUPS})(${n});
  if (!groups) return null;
  const h = window.innerHeight;
  const inside = groups.filter(list => { const c = list[0]; return c.y + c.h / 2 > 60 && c.y + c.h / 2 < h - 40; });
  if (!inside.length) return null;
  return (${rectOfList})(${pick});`);
};

async function commitAnnotation(text) {
  const btn = await page.eval(`const b = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    if (!b) return false; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (!btn) return false;
  await page.clickAt(btn.x, btn.y);
  await sleep(250);
  await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
  await page.type(text);
  await sleep(1200);
  await page.eval(`document.querySelector('#composer-save').click(); return 1;`);
  await sleep(1000);
  return true;
}

const cardCount = () => page.eval(`return document.querySelectorAll('#cards .card').length`);

/* 一切验收都绑到「具体批注 ID」，不用全局标记数量或任意卡片状态代替：
   数量对得上不代表画在对的位置，卡片状态也不保证属于同一条。 */
async function annotationById(id) {
  const api = await fetch(`${APP}api/annotations?p=${encodeURIComponent(DOC)}`).then((r) => r.json()).catch(() => ({}));
  return (api.annotations || []).find((a) => a.id === id) || null;
}
async function annotationIdByBody(fragment) {
  const api = await fetch(`${APP}api/annotations?p=${encodeURIComponent(DOC)}`).then((r) => r.json()).catch(() => ({}));
  const hit = (api.annotations || []).filter((a) => (a.body || "").includes(fragment)).pop();
  return hit ? hit.id : null;
}
/** 只属于这条批注的标记（含页码与几何），别的批注一个都不算 */
const marksOf = (id) => page.eval(`
  return [...document.querySelectorAll('#doc .pdf-text .anchor, #doc .pdf-text .mark')]
    .filter(m => m.dataset.ann === ${JSON.stringify(id)} && (m.textContent || '').trim())
    .map(m => { const r = m.getBoundingClientRect(); const pg = m.closest('.pdf-page');
      return { page: pg ? Number(pg.dataset.page) : null, t: (m.textContent || '').slice(0, 30),
               x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });`);
const cardOf = (id) => page.eval(`
  const c = document.querySelector('#cards .card[data-id="' + ${JSON.stringify(id)} + '"]');
  if (!c) return null;
  return { status: c.dataset.status, text: (c.textContent || '').replace(/\\s+/g, ' ').slice(0, 140),
           flags: [...c.querySelectorAll('.c-flag, .c-badge, .c-kind')].map(n => n.textContent.trim()).filter(Boolean) };`);

/** 真实拖选，并等「选区工具条真的出现」——条件等待，不用固定 sleep。
    没出现就按新坐标重拖一次；仍不行则如实返回 null，由调用方记成前置条件失败。 */
async function dragUntilMenu(targetFn, { steps = 14, tries = 3 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    // 上一次操作可能留下还在跑的平滑滚动，先等它停，否则坐标一取就过期
    await settleScroll();
    await sleep(200);
    const target = await targetFn();
    if (!target) return null;
    await page.drag(target.from, target.to, { steps });
    const shown = await page.waitFor(`return !document.querySelector('#sel-menu').hidden`, { label: "选区工具条", timeout: 4000 }).catch(() => false);
    if (shown) return target;
    // 失败留证：区分「浏览器压根没选中」和「选中了但被 app 拒绝」
    const diag = await page.eval(`
      const s = window.getSelection();
      const doc = document.querySelector('#doc');
      const inDoc = (n) => Boolean(n) && (n === doc || doc.contains(n));
      return { len: String(s || '').trim().length,
               rangeCount: s ? s.rangeCount : 0,
               anchorInDoc: s && s.anchorNode ? inDoc(s.anchorNode) : null,
               startInDoc: s && s.rangeCount ? inDoc(s.getRangeAt(0).startContainer) : null,
               menuHidden: document.querySelector('#sel-menu').hidden };`).catch(() => null);
    if (i === tries - 1) return { failed: true, diag, target };
  }
  return { failed: true, diag: null, target: null };
}

/** 拖选 + 提交，并断言「批注条数真的 +1」——不看函数返回值，看落库结果 */
async function annotate(targetFn, text, { steps = 14 } = {}) {
  const before = await cardCount();
  const target = await dragUntilMenu(targetFn, { steps });
  if (!target || target.failed) {
    const d = target && target.diag;
    const kind = d && d.len > 0 && d.startInDoc === false ? "起点在正文外（前置条件）"
      : d && d.len === 0 ? "浏览器没产生选区（前置条件）"
        : d ? "选区在正文内但工具条未出现（疑似产品）" : "取不到目标（前置条件）";
    return { ok: false, reason: `${kind} ${JSON.stringify(d)}`, before, after: before };
  }
  await commitAnnotation(text);
  const after = await page.waitFor(`return document.querySelectorAll('#cards .card').length > ${before}`, { label: "新批注出现", timeout: 6000 })
    .then(() => cardCount()).catch(() => cardCount());
  return { ok: after > before, reason: after > before ? null : "提交后批注数未增加", before, after };
}

const marksInfo = () => page.eval(`
  return [...document.querySelectorAll('#doc .pdf-text .anchor')].filter(m => (m.textContent || '').trim().length)
    .map(m => { const r = m.getBoundingClientRect();
      const pg = m.closest('.pdf-page');
      return { page: pg ? Number(pg.dataset.page) : null, t: (m.textContent || '').slice(0, 30),
               x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; });`);

async function waitAnchorsSettled(timeout = 25000) {
  const deadline = Date.now() + timeout;
  let prev = -1;
  while (Date.now() < deadline) {
    const n = await page.eval(`return document.querySelectorAll('#doc .pdf-text .anchor').length`).catch(() => -1);
    if (n >= 0 && n === prev) return n;
    prev = n;
    await sleep(500);
  }
  return prev;
}

async function reopen() {
  await page.navigate(APP);
  await openDoc(page, DOC);
  await waitAnchorsSettled();
}

try {
  await openDoc(page, DOC);
  const pageCount = await page.eval(`return document.querySelectorAll('#doc .pdf-page').length`);
  record("样本可打开（3 页，第 3 页旋转）", pageCount >= 3, `页数=${pageCount}`);

  /* ---------- 1. 重复句 ---------- */
  await focusPage(1);  // 每次取样前把第一页摆正，避免沿用上一次的滚动位置
  const dup1 = await lineTarget(DUP_HEAD, 1, 0);
  const dup2 = await lineTarget(DUP_HEAD, 1, 1);
  record("样本里确实有两次同名句", Boolean(dup1 && dup2) && dup1.from.y !== dup2.from.y,
    `第1处 y=${dup1 && Math.round(dup1.from.y)} 第2处 y=${dup2 && Math.round(dup2.from.y)}`);

  if (dup1 && dup2) {
    // 每次都重取坐标 + 等工具条出现 + 断言批注数真的 +1（旧写法只看函数返回值，第二条其实没建成也判通过）
    const r1 = await annotate(() => lineTarget(DUP_HEAD, 1, 0), "A04-1 第一次出现的重复句，请在这里补一个来源。");
    const r2 = await annotate(() => lineTarget(DUP_HEAD, 1, 1), "A04-2 第二次出现的重复句，请改为引用附录 B。");
    record("重复句：两条批注都真的建成（条数各 +1）", r1.ok && r2.ok && r2.after === r1.after + 1,
      `第1条 ${r1.before}→${r1.after}${r1.reason ? " " + r1.reason : ""}；第2条 ${r2.before}→${r2.after}${r2.reason ? " " + r2.reason : ""}`);
    // 按 ID 取两条各自的落点：不再用「全局标记里有几个落在某 y 带」来代替
    const id1 = await annotationIdByBody("A04-1");
    const id2 = await annotationIdByBody("A04-2");
    await reopen();
    const m1 = id1 ? await marksOf(id1) : [];
    const m2 = id2 ? await marksOf(id2) : [];
    const a1 = id1 ? await annotationById(id1) : null;
    const a2 = id2 ? await annotationById(id2) : null;
    const offsetDiff = a1 && a2 && Number.isFinite(a1.textOffset) && Number.isFinite(a2.textOffset) && a1.textOffset !== a2.textOffset;
    const farApart = m1.length > 0 && m2.length > 0 && Math.abs(m1[0].y - m2[0].y) > 40;
    record("重复句：两条批注各自锚定，未都钉到第一处（按 ID 校验）", Boolean(id1 && id2) && farApart && offsetDiff,
      `id1=${m1.length}片@y${m1[0] && m1[0].y} textOffset=${a1 && a1.textOffset}；id2=${m2.length}片@y${m2[0] && m2[0].y} textOffset=${a2 && a2.textOffset}；远距=${farApart} 偏移不同=${offsetDiff}`);
    await page.shot(`${OUT}/a04-duplicate.png`);
  }

  /* ---------- 2. 特殊空白 ---------- */
  await focusPage(1);
  const ws = await lineTarget(WS_HEAD, 1, 0);
  if (ws) {
    const rw = await annotate(() => lineTarget(WS_HEAD, 1, 0), "A04-3 这一行含全角与不换行空格，定位应仍然命中。", { steps: 12 });
    record("特殊空白：批注真的建成（条数 +1）", rw.ok, `${rw.before}→${rw.after}${rw.reason ? " " + rw.reason : ""}`);
    await reopen();
    const hit = (await marksInfo()).find((m) => m.t.includes("Whitespace"));
    record("特殊空白：含全角/不换行空格的句子仍能定位", Boolean(hit), hit ? JSON.stringify(hit) : "没有对应标记");
  } else {
    record("特殊空白：找到可拖选目标", false, "样本里没找到 Whitespace check 行");
  }

  /* ---------- 3. 跨页拖选 ---------- */
  // 把「第 1 页最后一行」与「第 2 页第一行」的中间点滚到视口中心。
  // 按页顶对齐不行：第 1 页末尾有留白，末行会被推出视口，端点就落在窗口外了。
  await page.eval(`const vp = document.querySelector('#viewport');
    const g1 = (${LINE_GROUPS})(1), g2 = (${LINE_GROUPS})(2);
    if (g1 && g2 && g1.length && g2.length) {
      const a = g1[g1.length - 1][0], b = g2[0][0];
      const mid = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
      vp.scrollTop += mid - vp.getBoundingClientRect().height / 2;
    }
    return 1;`);
  await settleScroll();
  const tailP1 = await visibleLine(1, "last");
  const headP2 = await visibleLine(2, "first");
  if (tailP1 && headP2) {
    // 起止都落在真实文字上：贴着 span 边缘（x+w-1）按下去可能落在文字层空白处，
    // 浏览器就不会把它当拖选起点。取行首内侧几个像素更稳。
    const fromPt = { x: Math.round(tailP1.from.x + 2), y: Math.round(tailP1.from.y) };
    const toPt = { x: Math.round(headP2.from.x + 2), y: Math.round(headP2.from.y) };
    const startViewportY = fromPt.y;
    await page.drag(fromPt, toPt, { steps: 24 });
    const sel = await page.eval(`return String(window.getSelection() || '').trim().length`);
    record("跨页拖选产生了选区", sel > 20, `选区长度=${sel}`);
    const menu = await page.eval(`const m = document.querySelector('#sel-menu');
      return { hidden: m.hidden, rect: (() => { const r = m.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })() };`);
    const quoteBefore = await page.eval(`return String(window.getSelection() || '').trim()`);
    const before = await cardCount();
    await commitAnnotation("A04-4 这条批注跨了页边界，定位不应钉到无关位置。");
    const after = await cardCount();
    const crossId = await annotationIdByBody("A04-4");
    record("跨页选区可建批注", after > before && Boolean(crossId), `卡片数 ${before} → ${after} 批注ID=${crossId ? "有" : "无"} 选区工具条=${JSON.stringify(menu)}`);
    // 落盘 quote 必须等于跨页拖到的文字（按 ID 取，不看别的批注）
    const crossAnn = crossId ? await annotationById(crossId) : null;
    const stripX = (v) => String(v || "").replace(/\s+/g, "");
    record("跨页批注落盘 quote 与选中文本一致", Boolean(crossAnn) && stripX(crossAnn.quote) === stripX(quoteBefore),
      crossAnn ? `quote长=${stripX(crossAnn.quote).length} 选区长=${stripX(quoteBefore).length}` : "取不到该批注");
    await reopen();
    // 只认这条 ID 的标记：别的批注一个都不算
    const ids = crossId ? await marksOf(crossId) : [];
    const above = ids.filter((m) => m.y < startViewportY - 60);
    record("跨页批注的标记不画在拖选起点之上（不跳文档开头/错段）", ids.length > 0 && above.length === 0,
      `本条标记=${ids.length} 片，起点y=${startViewportY} 最上=${ids.length ? Math.min(...ids.map((m) => m.y)) : "无"}${above.length ? " 越界=" + JSON.stringify(above.slice(0, 2)) : ""}`);
    // 反向确认：这条批注的标记文字必须落在它自己的 quote 里
    const recomposed = ids.map((m) => m.t).join("");
    record("跨页批注的标记文字属于它自己的 quote", Boolean(crossAnn) && stripX(crossAnn.quote).includes(stripX(recomposed).slice(0, 12)),
      `标记文字前 12=${stripX(recomposed).slice(0, 12)} quote 前 20=${stripX(crossAnn && crossAnn.quote).slice(0, 20)}`);
    await page.shot(`${OUT}/a04-crosspage.png`);
  } else {
    record("跨页：取到跨页选择目标", false, `tailP1=${Boolean(tailP1)} headP2=${Boolean(headP2)}`, "skip");
  }

  /* ---------- 3b. 反向用例：起点在正文之外 ----------
     从正文左侧的页边空白按下去、拖进正文，浏览器会把 anchor 留在文档外（这正是我们做「求交集」的原因）。
     这条用例要证明的是：修复之后也不会把「从文档开头到这里」整段当成一次批注。 */
  await focusPage(1);
  /* 起点必须**确定**在文档之外。前一版从「页面右侧空白」起手，浏览器会把起点吸附到页面首个文字位置，
     于是选区合法地覆盖了文档开头——那是标准浏览器行为，不是缺陷，但会让这条用例时红时绿。
     改用顶栏：在栏内找一个真正落在栏本身（而不是按钮）的 x。 */
  const outside = await page.eval(`
    const bar = document.querySelector('#bar');
    const br = bar.getBoundingClientRect();
    let sx = null;
    for (let x = Math.round(br.left + 10); x < br.right - 10; x += 4) {
      const el = document.elementFromPoint(x, Math.round(br.top + br.height / 2));
      if (el === bar) { sx = x; break; }
    }
    if (sx === null) return null;
    const pg = document.querySelector('#doc .pdf-page[data-page="1"]');
    const pr = pg.getBoundingClientRect();
    return { start: { x: sx, y: Math.round(br.top + br.height / 2) },
             end: { x: Math.round(pr.left + 30), y: Math.round(pr.top + 200) } };`);
  const cardsBeforeReverse = await cardCount();
  if (!outside) record("反向：能在顶栏找到非按钮的起点", false, "顶栏全是控件，无法构造确定性起点", "skip");
  await page.drag(outside.start, outside.end, { steps: 16 });
  const reverseMenu = await page.eval(`return !document.querySelector('#sel-menu').hidden`);
  let reverseQuote = null;
  if (reverseMenu) {
    const b = await page.eval(`const el = document.querySelector('#sel-menu button[data-sel-act="comment"]');
      if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
    if (b) {
      await page.clickAt(b.x, b.y);
      await sleep(250);
      await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
      await page.type("反向用例：起点在正文外。");
      await sleep(1300);
      reverseQuote = await page.eval(`return (document.querySelector('#composer-quote') || {}).textContent || null`);
      await page.eval(`const el = document.querySelector('#composer-save'); if (el) el.click(); return 1;`);
      await sleep(1000);
    }
  }
  const docHead = await page.eval(`const p = document.querySelector('#doc .pdf-page[data-page="1"]');
    return p ? [...p.querySelectorAll('.textLayer span')].map(s => s.textContent).join('').trim().slice(0, 20) : '';`);
  const cardsAfterReverse = await cardCount();
  if (cardsAfterReverse === cardsBeforeReverse) {
    record("反向：正文外起手的拖选不产生批注", true, `未新建（工具条=${reverseMenu}）`);
  } else {
    // 建了就必须检查它没有把文档开头整段吞进去
    const created = await page.eval(`return [...document.querySelectorAll('#cards .card')].map(c => (c.textContent||'').replace(/\\s+/g,' ')).slice(-1)[0] || ''`);
    const swallowedHead = created.includes(docHead.slice(0, 12));
    record("反向：正文外起手不得把「文档开头到这里」整段吞成一条批注", swallowedHead === false,
      `文档开头=「${docHead}」 卡片=${created.slice(0, 120)} 工具条文案=${JSON.stringify(reverseQuote)}`);
  }
  await page.shot(`${OUT}/a04-reverse-start.png`);
  // 收尾：把这条反向用例产生的批注删掉，避免影响后面计数
  await page.eval(`const cards = [...document.querySelectorAll('#cards .card')];
    const target = cards.find(c => (c.textContent || '').includes('反向用例'));
    if (target) { const del = target.querySelector('button[data-act="delete"]'); if (del) del.click(); }
    return 1;`);
  await sleep(800);

  /* ---------- 4. 旋转页 ---------- */
  await focusPage(3);
  /* 旋转页上文字是竖排的，「按 y 分行」的取法不成立；而且 span 的 AABB 中心不一定落在字形上
     （实测按中心按下去得到的是空选区）。用 caretRangeFromPoint 在 AABB 内扫格点，
     挑真正落在这个 span 文字节点上的点。 */
  const rot = await page.eval(`
    const pg = document.querySelector('#doc .pdf-page[data-page="3"]');
    if (!pg) return { none: true, count: 0 };
    const spans = [...pg.querySelectorAll('.textLayer span')].filter(s => (s.textContent || '').trim().length > 2);
    const pointIn = (s) => {
      const r = s.getBoundingClientRect();
      for (let gy = 0.3; gy <= 0.71; gy += 0.2) {
        for (let gx = 0.15; gx <= 0.86; gx += 0.1) {
          const x = r.x + r.width * gx, y = r.y + r.height * gy;
          const c = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
          if (c && c.startContainer && s.contains(c.startContainer)) return { x: Math.round(x), y: Math.round(y) };
        }
      }
      return null;
    };
    const a = pointIn(spans[0]);
    const b = pointIn(spans[Math.min(2, spans.length - 1)]);
    if (!a || !b) return { none: true, count: spans.length };
    return { from: a, to: b, joined: spans.slice(0, 3).map(s => s.textContent).join('').slice(0, 40), count: spans.length };`);
  if (!rot || rot.none) {
    record("旋转页：真实拖选（取不到落在旋转文字上的拖选点，产品行为未被验证）", false,
      `spans=${rot && rot.count}；旋转文字层上 caretRangeFromPoint 取不到落在 span 内的点`, "skip");
  }
  if (rot && !rot.none) {
    await page.drag(rot.from, rot.to, { steps: 14 });
    // 旋转页的 span 带 transform，按 AABB 中心按下去不一定落在字形上——先判定这次拖选是否落在正文内，
    // 落在正文外属于「测试前置条件不足」，不能记成产品失败
    const selDiag = await page.eval(`
      const s = window.getSelection();
      const inDoc = (n) => Boolean(n) && (n === document.querySelector('#doc') || document.querySelector('#doc').contains(n));
      return { len: String(s || '').trim().length,
               anchorInDoc: s && s.anchorNode ? inDoc(s.anchorNode) : null,
               startInDoc: s && s.rangeCount ? inDoc(s.getRangeAt(0).startContainer) : null };`);
    const before = await cardCount();
    const ok = await commitAnnotation("A04-5 旋转页上的批注，虚线应贴在原文字下方。");
    const grew = (await cardCount()) > before;
    if (selDiag.startInDoc === false) {
      record("旋转页：真实拖选（本次起点落在正文之外，产品行为未被验证）", false,
        `选区长=${selDiag.len} anchorInDoc=${selDiag.anchorInDoc} startInDoc=${selDiag.startInDoc}`, "skip");
    } else {
      record("旋转页：可拖选并建批注", ok && grew, `选区长度=${selDiag.len} 卡片 ${before} → ${await cardCount()}`);
    }
    await reopen();
    // 把标记本身滚到视口中间再判定：文档可以滚到顶栏下面（y=28 时 elementFromPoint 命中 HEADER），
    // 那是用户自己的滚动位置，不是标记错位
    await page.eval(`const a = document.querySelector('#doc .pdf-page[data-page="3"] .anchor'); if (a) a.scrollIntoView({ block: 'center' }); return 1;`);
    await settleScroll();
    const aligned = await page.eval(`
      const ms = [...document.querySelectorAll('#doc .pdf-page[data-page="3"] .anchor')].filter(m => (m.textContent || '').trim());
      let ok = 0; const bad = []; const detail = [];
      for (const m of ms) { const r = m.getBoundingClientRect();
        const a = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const hit = a && (a === m || m.contains(a) || a.contains(m));
        if (hit) ok += 1; else bad.push((m.textContent || '').slice(0, 12));
        detail.push({ t: (m.textContent || '').slice(0, 10), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                      hit: a ? a.tagName + '.' + String(a.className).slice(0, 16) : null,
                      parent: (() => { const p = m.parentElement; const pr = p.getBoundingClientRect();
                        return { cls: String(p.className).slice(0, 20), x: Math.round(pr.x), y: Math.round(pr.y), w: Math.round(pr.width), h: Math.round(pr.height) }; })() }); }
      return { total: ms.length, ok, bad, detail };`);
    record("旋转页：批注能定位到第 3 页", aligned.total > 0, JSON.stringify(aligned));
    record("旋转页：标记贴合文字", aligned.total > 0 && aligned.ok === aligned.total, JSON.stringify(aligned.bad));
    await page.shot(`${OUT}/a04-rotated.png`);
  }

  /* ---------- A03 原文整段替换 ---------- */
  await focusPage(2);
  const tail = await lineTarget(TAIL, 2, 0);
  if (tail) {
    await page.drag(tail.from, tail.to, { steps: 14 });
    await commitAnnotation("A03 这条批注的原句稍后会被整段替换掉。");
    const replacedId = await annotationIdByBody("A03");
    const beforeReplace = replacedId ? await annotationById(replacedId) : null;
    record("A03：被替换的那条批注已建成并记录 ID", Boolean(replacedId),
      `批注ID=${replacedId ? "有" : "无"} quote 前 30=「${beforeReplace && beforeReplace.quote.slice(0, 30)}」`);
    await sleep(600);
    await copyFile(`${FIX}/A04.b.pdf`, `${VAULT}/${DOC}`); // 那句原文彻底不存在了
    await reopen();
    await page.waitFor(`return document.querySelectorAll('#cards .card').length > 0`, { label: "重开后卡片列表", timeout: 15000 }).catch(() => null);
    const ownMarks = replacedId ? await marksOf(replacedId) : [];
    const ownCard = replacedId ? await cardOf(replacedId) : null;
    // 判据全部按这条 ID：它自己的标记、它自己的卡片，不数全局标记、不看"任意一张卡"的文字
    record("A03 原文被整段替换后，这条批注不把线画到新文字上", ownMarks.length === 0,
      ownMarks.length ? JSON.stringify(ownMarks.slice(0, 3)) : `本条标记=0（卡片状态=${ownCard && ownCard.status}）`);
    const saysChanged = Boolean(ownCard) && (/锚点失效|需确认位置|待定位|原文已变更|已过期/.test(`${ownCard.text}${ownCard.flags.join("")}`) || ownCard.status === "stale");
    record("A03 这条批注明确提示「原文已变化/待确认」而不是静默当成功", saysChanged, JSON.stringify(ownCard));
    await page.shot(`${OUT}/a03-replaced.png`);
    const marks = ownMarks;
  } else {
    record("A03：取到被替换的目标段落", false, "样本里没找到 tail 段落", "skip");
  }

  record("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  record("执行中断", false, String(error?.message || error));
  try { await page.shot(`${OUT}/a04-fail.png`); } catch { /* ignore */ }
} finally {
  await copyFile(`${FIX}/A04.a.pdf`, `${VAULT}/${DOC}`); // 复原样本
  await writeFile(`${OUT}/a03-a04.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
