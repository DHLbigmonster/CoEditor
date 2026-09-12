// 「更多」菜单里新手用不到的进阶项应当隐藏，其余项不受影响，且不影响 app.js 的事件绑定
// 用法: COEDITOR_CDP_HTTP=http://127.0.0.1:9337 COEDITOR_APP=http://127.0.0.1:4595/ node tools/check-menu-visible.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4595/";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const rec = (step, ok, detail) => {
  log.push({ step, ok: Boolean(ok), detail });
  console.log(`${ok ? "✅" : "❌"} ${step}${detail ? ` — ${detail}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });
await openDoc(page, "研究设计-英文摘要.pdf");
await page.eval(`document.querySelector('#view-menu').open = true; return 1;`);
await sleep(400);

const got = await page.eval(`
  const vis = (sel) => { const el = document.querySelector(sel); if (!el) return null;
    return getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0; };
  const seps = [...document.querySelectorAll('.menu-sep')].map((s) => getComputedStyle(s).display !== 'none');
  return { editAsk: vis('#btn-edit-ask'), round: vis('#btn-round'),
           layout: vis('#btn-layout'), theme: vis('#btn-theme'),
           sepsVisible: seps.filter(Boolean).length,
           editAskInDom: !!document.querySelector('#btn-edit-ask'),
           roundInDom: !!document.querySelector('#btn-round') };`);

rec("「把修改指令交给 Agent」已隐藏", got.editAsk === false, JSON.stringify(got));
rec("「归档本轮，开新批次」已隐藏", got.round === false, "");
rec("菜单其余项照常可见（没误伤）", got.layout === true && got.theme === true, `重置画布布局=${got.layout} 纸张=${got.theme}`);
rec("没有留下孤零零的分隔线", got.sepsVisible === 0, `可见分隔线 ${got.sepsVisible} 条`);
rec("两个按钮仍在 DOM 里（app.js 的事件绑定不受影响）", got.editAskInDom && got.roundInDom, "");
await page.shot(`${OUT}/view-menu-after.png`);
await page.close();

const fail = log.filter((l) => !l.ok).length;
console.log(`\nPASS ${log.length - fail} / FAIL ${fail}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
