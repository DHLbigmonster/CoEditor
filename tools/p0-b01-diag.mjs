// B01 根因诊断：把「保存到 sidecar 的 quote」与「重开后 rebuild 出来的文本索引」逐字节比对
// 用法: node tools/p0-b01-diag.mjs
import { openPage, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_B01_DOC || "研究设计-技术附录.pdf";

const page = await openPage(APP, { width: 1440, height: 900 });
const treeExpr = `const r0 = document.querySelector('[data-path="${DOC}"]');
  if (!r0) return null; r0.scrollIntoView({ block: 'center' });
  const r = r0.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`;

const tree = await page.waitFor(treeExpr, { label: "文件树" });
await page.clickAt(tree.x, tree.y);
await page.waitFor(`return document.querySelectorAll('#doc .pdf-page .textLayer span').length > 20`, { label: "文字层" });
await sleep(1500);

const out = await page.eval(`
  const root = document.querySelector('#doc');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = ''; let n;
  while ((n = walker.nextNode())) text += n.nodeValue;

  const api = await fetch('/api/annotations?p=' + encodeURIComponent(${JSON.stringify(DOC)})).then(r => r.json()).catch(e => ({ error: String(e) }));
  const list = api.annotations || api.items || (Array.isArray(api) ? api : []);
  const withQuote = list.filter(x => x && typeof x.quote === 'string' && x.quote.length);
  const norm = s => String(s).replace(/\\s+/g, '');
  const normKeep = s => String(s).replace(/[\\u0009\\u000a\\u000b\\u000c\\u000d]/g, ' ');

  return {
    doc: ${JSON.stringify(DOC)},
    annotations: list.length,
    indexLen: text.length,
    indexHead: text.slice(0, 160),
    samples: withQuote.slice(0, 3).map(a => ({
      id: a.id,
      quoteLen: a.quote.length,
      quoteHead: a.quote.slice(0, 160),
      hasNewline: /[\\n\\r]/.test(a.quote),
      exactHit: text.indexOf(a.quote),
      wsCollapseHit: normKeep(text).indexOf(normKeep(a.quote)),
      noWsHit: norm(text).indexOf(norm(a.quote)),
      head24Hit: text.indexOf(a.quote.slice(0, 24)),
      prefixHit: a.prefix ? text.indexOf((a.prefix + a.quote).slice(-a.quote.length)) : -1
    }))
  };`);

console.log(JSON.stringify(out, null, 2));
await mkdir("/tmp/coeditor-p0/evidence", { recursive: true });
await writeFile(`/tmp/coeditor-p0/evidence/b01-diag-${DOC}.json`, JSON.stringify(out, null, 2), "utf8");
await page.close();
