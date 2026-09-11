// B01 附加：真实点击缩放按钮，逐档验证「标记仍贴在对应文字下方，无重影、无错标」
// 前置：已存在批注（先跑 tools/p0-b01.mjs）
// 用法: node tools/p0-b01-zoom.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir, readFile } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_B01_DOC || "研究设计-英文摘要.pdf";
const OUT = "/tmp/coeditor-p0/evidence";
const TARGETS = [50, 100, 150, 200];

const log = [];
const record = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 200)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
const errors = [];
page.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || "").slice(0, 200)); });

const readZoom = () => page.eval(`return parseInt(document.querySelector('#zoom').textContent, 10) || 0`);

/** 等标记数量收敛：PDF 缩放重渲染会先清 DOM 再重新锚定，单次取样会撞上中间态 */
async function waitStableAnchors({ timeout = 30000 } = {}) {
  const deadline = Date.now() + timeout;
  let prev = -1;
  while (Date.now() < deadline) {
    const n = await page.eval(`return document.querySelectorAll('#doc .pdf-text .anchor').length`).catch(() => 0);
    if (n > 0 && n === prev) return n;
    prev = n;
    await sleep(600);
  }
  return prev;
}
const btnRect = (id) => page.eval(`const b = document.querySelector('#${id}'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 };`);

try {
  await openDoc(page, DOC);
  // 等标记稳定再取基线：PDF 缩放重渲染会先清空 DOM 再重新锚定，单次取样可能撞上中间态
  await waitStableAnchors();

  const dump = await page.eval(`return [...document.querySelectorAll('#doc .pdf-text .anchor')].map(m => {
    const r = m.getBoundingClientRect();
    return { t: (m.textContent || '').slice(0, 6), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  });`);
  console.log("标记分块:", JSON.stringify(dump));

  const baseline = await page.eval(`return document.querySelectorAll('#doc .pdf-text .anchor').length`);
  const baselineTextMarks = await page.eval(`return [...document.querySelectorAll('#doc .pdf-text .anchor')]
    .filter(m => /[\\p{L}\\p{N}]/u.test(m.textContent || '')).length`);
  record("基线：存在批注标记", baseline > 0, `分片=${baseline} 其中有内容=${baselineTextMarks}`);

  for (const target of TARGETS) {
    // 用真实点击把倍率调到目标（±5% 容差，最多 40 次点击）
    for (let i = 0; i < 40; i += 1) {
      const current = await readZoom();
      if (Math.abs(current - target) <= 5) break;
      const id = current < target ? "btn-in" : "btn-out";
      const rect = await btnRect(id);
      if (!rect) { record(`缩放控件 #${id} 存在`, false); break; }
      await page.clickAt(rect.x, rect.y);
      await sleep(260);
    }
    await waitStableAnchors();
    const actual = await readZoom();
    // 把被批注的那一页滚回视口，否则分片全在屏幕外，命中测试无从谈起
    await page.eval(`const a = document.querySelector('#doc .pdf-text .anchor'); if (a) a.scrollIntoView({ block: 'center' }); return 1;`);
    await sleep(500);
    // 取样口径（不是放宽标准）：
    //  - 只取视口内的分片：滚出屏幕的分片 elementFromPoint 必然落空，断言它没有意义
    //  - 只取含实义字符（字母/数字/汉字）的分片：PDF 文字层把空格与标点也切成单独 span，
    //    标点字形框远宽于墨迹（"·" 框宽 25px、墨迹几像素），命中的是邻居元素
    const marks = await page.eval(`const vp = document.querySelector('#viewport').getBoundingClientRect();
      const ms = [...document.querySelectorAll('#doc .pdf-text .anchor')]
        .filter(m => /[\\p{L}\\p{N}]/u.test(m.textContent || ''));
      return ms.map(m => { const r = m.getBoundingClientRect();
        const visible = r.bottom > vp.top && r.top < vp.bottom && r.width > 0;
        const at = visible ? document.elementFromPoint(r.x + r.width/2, r.y + r.height/2) : null;
        return { t: (m.textContent||'').slice(0,6), y: Math.round(r.y), w: +r.width.toFixed(1), h: +r.height.toFixed(1),
                 visible,
                 inside: !visible || !!(at && (at === m || m.contains(at) || at.contains(m))),
                 deco: getComputedStyle(m).textDecorationColor }; });`);
    const bad = marks.filter((m) => m.visible && (!m.inside || m.w < 2 || m.h < 2));
    record(`${actual}% 档：标记数量不重影`, marks.length === baselineTextMarks, `实际=${actual}% 有内容分片=${marks.length}/${baselineTextMarks}`);
    record(`${actual}% 档：标记贴合文字`, bad.length === 0, bad.length ? JSON.stringify(bad.slice(0, 3)) : `全部 ${marks.length} 片贴合`);
    await page.shot(`${OUT}/b01-zoom-${actual}.png`);
  }
  record("无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  record("执行中断", false, String(error?.message || error));
} finally {
  await writeFile(`${OUT}/b01-zoom.json`, JSON.stringify({ doc: DOC, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const failed = log.filter((l) => !l.ok);
console.log(`\n结果：${log.length - failed.length}/${log.length} 通过`);
process.exit(failed.length ? 1 : 0);
