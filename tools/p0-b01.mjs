// B01 真实链路：真实鼠标拖选 → 写中文意见 → 落盘 → 重开 → 定位 → 绘制
//
// 规格 §B01 要求「禁止直接注入 state 作为唯一通过证据」。本脚本全程真实输入，
// 每一段都留证据到 /tmp/coeditor-p0/evidence/。
//
// 用法: node tools/p0-b01.mjs   （需先起服务与 CDP Chrome，见 LOCAL-BASELINE.md §4）
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_B01_DOC || "研究设计-英文摘要.pdf";
const SIDECAR = process.env.COEDITOR_B01_SIDECAR || "/private/tmp/coeditor-p0/vault/.marginalia/annotations.json";
const OUT = "/tmp/coeditor-p0/evidence";
const BODY = "这段结论需要补一个实证例子，引用来源后再定稿。";

/* 树项按 data-path 定位：文件名与后缀是两个独立 span（规格 §3.3「省略时固定保留后缀」），
   用 textContent 全等匹配必然落空。 */
const treeExpr = `const row = document.querySelector('[data-path="${DOC}"]');
  if (!row) return null;
  row.scrollIntoView({ block: 'center' });
  const r = row.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`;

/** 等标记渲染收敛：连续两次读数一致才认为结束（PDF 重建期间会短暂为 0） */
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

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 220)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
const consoleErrors = [];
page.onEvent((msg) => {
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description || "").slice(0, 300));
  if (msg.method === "Runtime.consoleAPICalled" && msg.params?.type === "error") {
    consoleErrors.push(String(msg.params.args?.[0]?.value ?? "").slice(0, 300));
  }
});

try {
  /* ---------- 1. 打开文档 ---------- */
  const treeRect = await openDoc(page, DOC);
  record("点击文件树打开 PDF", true, treeRect);
  const spanCount = await page.eval(`return document.querySelectorAll('#doc .pdf-page .textLayer span').length`);
  record("PDF 文字层建立", true, `span=${spanCount}`);

  /* ---------- 2. 真实鼠标跨行拖选 ---------- */
  const spans = await page.eval(`const list = [...document.querySelectorAll('#doc .pdf-page[data-page="1"] .textLayer span')]
      .filter(s => (s.textContent || '').trim().length > 2)
      .slice(0, 80)
      .map(s => { const r = s.getBoundingClientRect(); return { t: s.textContent.trim(), x: r.x, y: r.y, w: r.width, h: r.height }; })
      .filter(s => s.w > 8 && s.h > 4);
    return list;`);
  const first = spans[3] || spans[0];
  const lower = spans.find((s) => s.y > first.y + first.h * 1.6 && s.x < first.x + 40) || spans[12] || spans[spans.length - 1];
  const from = { x: first.x + 1, y: first.y + first.h / 2 };
  const to = { x: lower.x + lower.w - 1, y: lower.y + lower.h / 2 };
  await page.drag(from, to, { steps: 14 });

  const selection = await page.eval(`return String(window.getSelection() || '').trim()`);
  record("真实拖选产生跨行选区", selection.length > 4, `选区=${JSON.stringify(selection.slice(0, 60))} 长度=${selection.length}`);

  // 记下选区在「页面内」的归一化几何：重开后要拿标记的几何跟它比，
  // 而不是只数"有几个标记"（规格：标记必须落在对应文字下方）
  const selGeom = await page.eval(`
    const s = window.getSelection();
    if (!s.rangeCount) return null;
    const r = s.getRangeAt(0).getBoundingClientRect();
    const pg = document.querySelector('#doc .pdf-page[data-page="1"]');
    if (!pg) return null;
    const pr = pg.getBoundingClientRect();
    if (!pr.width || !pr.height) return null;
    return { x: (r.x - pr.x) / pr.width, y: (r.y - pr.y) / pr.height, w: r.width / pr.width, h: r.height / pr.height };`);
  record("记录选区几何（供重开后比对）", Boolean(selGeom), JSON.stringify(selGeom));

  const menuVisible = await page.eval(`return !document.querySelector('#sel-menu').hidden`);
  record("选区工具条出现", menuVisible);

  /* ---------- 3. 点「批注」 ---------- */
  const btn = await page.eval(`const b = document.querySelector('#sel-menu button[data-sel-act="comment"]');
    if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`);
  if (!btn) throw new Error("找不到批注按钮");
  await page.clickAt(btn.x, btn.y);
  await sleep(300);
  const composerOpen = await page.eval(`return !document.querySelector('#composer').hidden`);
  record("批注输入框打开", composerOpen);

  /* ---------- 4. 真实键入中文 ---------- */
  await page.eval(`const t = document.querySelector('#composer-input'); t.focus(); return document.activeElement === t;`);
  await page.type(BODY);
  const typed = await page.eval(`return document.querySelector('#composer-input').value`);
  record("中文意见键入", typed === BODY, `值=${JSON.stringify(typed.slice(0, 40))}`);

  /* ---------- 5. 等待自动保存（600ms 防抖） ---------- */
  await sleep(1600);
  let disk = null;
  try { disk = JSON.parse(await readFile(SIDECAR, "utf8")); } catch (e) { /* 未落盘 */ }
  const entries = disk ? Object.values(disk.docs || disk)[0] : null;
  const saved = disk ? JSON.stringify(disk).includes(BODY.slice(0, 12)) : false;
  record("意见落盘到 sidecar", saved, saved ? "包含意见正文" : `sidecar=${SIDECAR} 未写入`);

  const api = await fetch(`${APP}api/annotations?p=${encodeURIComponent(DOC)}`).then((r) => r.json()).catch((e) => ({ error: String(e) }));
  const apiHas = JSON.stringify(api).includes(BODY.slice(0, 12));
  record("API 可回读", apiHas, apiHas ? "包含意见正文" : JSON.stringify(api).slice(0, 160));

  // 【一致性之一】落盘的 quote 必须就是刚才选中的那段文字（去空白后逐字相等）
  const strip = (v) => String(v || "").replace(/\s+/g, "");
  const savedQuote = (api.annotations || []).filter((a) => (a.body || "").includes(BODY.slice(0, 8))).pop();
  record("落盘 quote 与选中文本逐字一致", Boolean(savedQuote) && strip(savedQuote.quote) === strip(selection),
    savedQuote ? `quote长=${savedQuote.quote.length} 选区长=${selection.length} 一致=${strip(savedQuote.quote) === strip(selection)}` : "没找到刚建的这条");

  /* ---------- 6. 重新打开（刷新页面）---------- */
  await page.navigate(APP);
  await openDoc(page, DOC);
  // 重开后 PDF 会被重建多次（实测 3 次），每次重建都先清空 #doc 再重新锚定。
  // 固定 sleep 会随机撞进「已清空、尚未重新锚定」的空窗，造成假失败——等收敛再取样。
  await waitAnchorsSettled();

  const marks = await page.eval(`const ms = [...document.querySelectorAll('#doc .pdf-text .anchor')];
    return ms.map(m => { const r = m.getBoundingClientRect();
      return { kind: m.dataset.kind, status: m.dataset.status, ann: m.dataset.ann, text: (m.textContent||'').slice(0, 40),
               x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
               deco: getComputedStyle(m).textDecorationLine + '/' + getComputedStyle(m).textDecorationColor }; });`);
  record("重开后原文出现批注标记", marks.length > 0, `标记数=${marks.length} ${JSON.stringify(marks[0] || {})}`);

  const green = marks.filter((m) => /57,\s*128,\s*90|#39805a|rgb\(57, 128, 90\)/.test(m.deco || ""));
  record("标记为待修改绿虚线", green.length > 0, `deco=${marks[0]?.deco}`);

  // 标记是否落在被选文字上（几何对齐：标记矩形与选区文字行相交）
  const aligned = await page.eval(`const m = document.querySelector('#doc .pdf-text .anchor');
    if (!m) return null;
    const r = m.getBoundingClientRect();
    const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { hitTag: at ? at.tagName : null, hitClass: at ? String(at.className) : null, inside: !!(at && (at === m || m.contains(at) || at.contains(m))) };`);
  record("标记位置与文字重合（未被遮挡/未错位）", Boolean(aligned?.inside), JSON.stringify(aligned));

  // 【一致性之二】重开后标记里的文字 == 落盘的 quote（去空白后相等）
  const markText = marks.map((m) => m.text).join("");
  const markFull = await page.eval(`return [...document.querySelectorAll('#doc .pdf-page[data-page="1"] .anchor')]
    .filter(m => (m.textContent || '').trim()).map(m => m.textContent).join('');`);
  record("重开后标记文字 == 落盘 quote", Boolean(savedQuote) && strip(markFull) === strip(savedQuote.quote),
    `标记文字长=${strip(markFull).length} quote长=${strip(savedQuote?.quote || "").length}`);

  // 【一致性之三】标记几何 == 当初选区的几何（页面内归一化，容差 3% 页宽/页高）
  const markGeom = await page.eval(`
    const ms = [...document.querySelectorAll('#doc .pdf-page[data-page="1"] .anchor')].filter(m => (m.textContent || '').trim());
    if (!ms.length) return null;
    const pg = document.querySelector('#doc .pdf-page[data-page="1"]');
    const pr = pg.getBoundingClientRect();
    let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    for (const m of ms) { const r = m.getBoundingClientRect();
      x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); }
    return { x: (x1 - pr.x) / pr.width, y: (y1 - pr.y) / pr.height, w: (x2 - x1) / pr.width, h: (y2 - y1) / pr.height };`);
  const geomOk = Boolean(selGeom && markGeom)
    && Math.abs(markGeom.y - selGeom.y) <= 0.03
    && Math.abs(markGeom.x - selGeom.x) <= 0.03
    && Math.abs(markGeom.w - selGeom.w) <= 0.05
    && Math.abs(markGeom.h - selGeom.h) <= 0.05;
  record("重开后标记几何 == 当初选区几何（≤3% 页宽高）", geomOk,
    `选区=${JSON.stringify(selGeom && { x: +selGeom.x.toFixed(3), y: +selGeom.y.toFixed(3), w: +selGeom.w.toFixed(3), h: +selGeom.h.toFixed(3) })} 标记=${JSON.stringify(markGeom && { x: +markGeom.x.toFixed(3), y: +markGeom.y.toFixed(3), w: +markGeom.w.toFixed(3), h: +markGeom.h.toFixed(3) })}`);

  await page.shot(`${OUT}/b01-reopen.png`);
  record("截图存档", true, `${OUT}/b01-reopen.png`);

  record("页面无 JS 异常", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
} catch (error) {
  record("执行中断", false, String(error?.message || error));
  try { await page.shot(`${OUT}/b01-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/b01.json`, JSON.stringify({ doc: DOC, body: BODY, at: new Date().toISOString(), log, consoleErrors }, null, 2), "utf8");
  await page.close();
}

const failed = log.filter((l) => !l.ok);
console.log(`\n结果：${log.length - failed.length}/${log.length} 通过`);
process.exit(failed.length ? 1 : 0);
