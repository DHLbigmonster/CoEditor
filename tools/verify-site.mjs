// 官网验收：三档宽度无横向溢出、键盘可达、演示页真交互、无虚构宣传语
// 跑之前：cd site && python3 -m http.server 4680 --bind 127.0.0.1
// 用法: node tools/verify-site.mjs
import { openPage, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const BASE = process.env.SITE_BASE || "http://127.0.0.1:4680/";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(BASE, { width: 1440, height: 900 });
const errors = [];
page.onEvent((m) => { if (m.method === "Runtime.exceptionThrown") errors.push(String(m.params?.exceptionDetails?.exception?.description || "").slice(0, 160)); });

const metrics = () => page.eval(`
  const html = document.documentElement;
  return { inner: window.innerWidth, overflow: html.scrollWidth - html.clientWidth,
           h1: (document.querySelector('h1') || {}).textContent || null,
           imgs: [...document.images].map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth })),
           links: [...document.querySelectorAll('a[href^="http"]')].map(a => a.href),
           emptyLinks: [...document.querySelectorAll('a')].filter(a => !a.getAttribute('href') || a.getAttribute('href') === '#').length,
           offenders: html.scrollWidth - html.clientWidth > 1
             ? [...document.querySelectorAll('body *')].map(el => { const r = el.getBoundingClientRect();
                 return { sel: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''),
                          right: Math.round(r.right), w: Math.round(r.width), ox: getComputedStyle(el).overflowX }; })
                 .filter(x => x.right > window.innerWidth + 1 && x.w > 0).slice(0, 6)
             : [] };`);

try {
  /* ---------- 1. 三档宽度 ---------- */
  for (const w of [1440, 768, 390]) {
    await page.navigate(`${BASE}index.html`);
    await page.setViewport(w, 900);
    await sleep(700);
    const m = await metrics();
    record(`${w}px：首页无横向溢出`, m.overflow <= 1,
      `overflow=${m.overflow}${m.offenders.length ? " 越界=" + JSON.stringify(m.offenders) : ""}`);
    record(`${w}px：首屏显示新版产品标题`, m.h1 === "哪里想改，就写在哪里。", JSON.stringify(m.h1));
    record(`${w}px：图片全部加载成功`, m.imgs.every((i) => i.ok), JSON.stringify(m.imgs.map((i) => `${i.src}:${i.ok ? i.w + "px" : "加载失败"}`)));
    await page.shot(`${OUT}/site-${w}.png`);
  }

  /* ---------- 2. 键盘可达 + 无空链接 ---------- */
  await page.navigate(`${BASE}index.html`);
  await page.setViewport(1440, 900);
  await sleep(500);
  const firstFocus = await page.eval(`
    const a = document.querySelector('.nav a');
    a.focus();
    return { tag: document.activeElement.tagName, href: document.activeElement.getAttribute('href'), visible: !!document.activeElement.offsetParent };`);
  record("导航可用键盘聚焦", firstFocus.tag === "A" && firstFocus.visible, JSON.stringify(firstFocus));
  await page.shot(`${OUT}/site-focus.png`);

  const m2 = await metrics();
  record("没有空链接（href 为空或 #）", m2.emptyLinks === 0, `空链接数=${m2.emptyLinks}`);
  record("外链都指向真实地址", m2.links.every((u) => /^https:\/\//.test(u)), JSON.stringify(m2.links.slice(0, 4)));

  /* ---------- 3. 不出现虚构宣传 ---------- */
  const text = await page.eval(`return document.body.innerText`);
  const banned = ["客户案例", "用户数", "下载量", "推荐语", "Trusted by", "50,000"];
  const hit = banned.filter((b) => text.includes(b));
  record("首页没有虚构的用户数/客户/推荐语", hit.length === 0, hit.length ? JSON.stringify(hit) : "未出现");
  record("首页明确说明暂无预编译安装包", /暂无预编译安装包|暂时没有预编译安装包/.test(text), "");
  record("首页说明 PPT 需要可选组件", /LibreOffice/.test(text) && /可选/.test(text), "");

  /* ---------- 4. 演示页真交互 ---------- */
  await page.navigate(`${BASE}demo.html`);
  await page.setViewport(1440, 900);
  await sleep(600);
  const before = await page.eval(`return { marks: document.querySelectorAll('.demo-doc span[class^="mark-"]').length,
    cards: document.querySelectorAll('.demo-card').length, count: document.querySelector('#demo-count').textContent };`);
  record("演示页初始为空", before.marks === 0 && before.cards === 0, JSON.stringify(before));

  // 真拖选第一段里的一句话
  const target = await page.eval(`
    const p = document.querySelectorAll('#demo-doc p')[1];
    const node = p.firstChild;
    // 找到文本里的一段，构造 Range 选它，再用真实鼠标拖出等价选区
    const text = node.nodeValue;
    const start = text.indexOf('写字楼商圈');
    const end = start + 6;
    const r = document.createRange();
    r.setStart(node, start); r.setEnd(node, end);
    const rect = r.getBoundingClientRect();
    return { x1: Math.round(rect.left + 1), y1: Math.round(rect.top + rect.height / 2),
             x2: Math.round(rect.right - 1), y2: Math.round(rect.bottom - rect.height / 2) };`);
  await page.drag({ x: target.x1, y: target.y1 }, { x: target.x2, y: target.y2 }, { steps: 10 });
  const menuShown = await page.eval(`return !document.querySelector('#sel-menu').hidden`);
  record("演示页：选中文字后出现三个动作", menuShown, `menu hidden=${!menuShown}`);

  const btn = await page.eval(`const b = document.querySelector('#sel-menu button[data-act="comment"]');
    const r = b.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
  await page.clickAt(btn.x, btn.y);
  await sleep(300);
  const composerOpen = await page.eval(`return !document.querySelector('#composer').hidden`);
  record("演示页：批注输入框打开", composerOpen);
  await page.eval(`document.querySelector('#composer-input').focus(); return 1;`);
  await page.type("这里要补一个口径说明。");
  await page.eval(`document.querySelector('#composer-save').click(); return 1;`);
  await sleep(500);

  const after = await page.eval(`return { marks: document.querySelectorAll('.mark-dashed').length,
    cards: document.querySelectorAll('.demo-card').length,
    cardText: (document.querySelector('.demo-card') || {}).textContent || '',
    count: document.querySelector('#demo-count').textContent,
    deco: (() => { const m = document.querySelector('.mark-dashed'); return m ? getComputedStyle(m).textDecorationColor : null; })() };`);
  record("演示页：写完后原文出现绿色虚线标记", after.marks > 0 && /57,\s*128,\s*90/.test(after.deco || ""), JSON.stringify(after).slice(0, 200));
  record("演示页：右侧出现意见卡并计数", after.cards === 1 && after.count.includes("1 条意见"), `卡片=${after.cards} 计数=${after.count}`);

  await page.eval(`document.querySelectorAll('.demo-card button')[0].click(); return 1;`);
  await sleep(300);
  const doneState = await page.eval(`return { done: document.querySelector('.mark-dashed').classList.contains('is-done'),
    deco: getComputedStyle(document.querySelector('.mark-dashed')).textDecorationColor,
    cardDone: !!document.querySelector('.demo-card.done') };`);
  record("演示页：「已处理」后标记变灰且卡片状态跟着变", doneState.done && doneState.cardDone && !/57,\s*128,\s*90/.test(doneState.deco), JSON.stringify(doneState));
  await page.shot(`${OUT}/site-demo.png`);

  await page.eval(`document.querySelector('#demo-reset').click(); return 1;`);
  await sleep(300);
  const reset = await page.eval(`return { marks: document.querySelectorAll('.mark-dashed').length, cards: document.querySelectorAll('.demo-card').length };`);
  record("演示页：重置后回到干净状态", reset.marks === 0 && reset.cards === 0, JSON.stringify(reset));

  /* ---------- 5. 其他页面可打开 ---------- */
  for (const p of ["download.html", "help.html", "privacy.html", "changelog.html", "404.html"]) {
    const res = await fetch(`${BASE}${p}`);
    const okStatus = res.status === 200;
    const html = await res.text();
    record(`${p} 可访问且引用了样式`, okStatus && html.includes("styles.css"), `status=${res.status}`);
  }
  const robots = await fetch(`${BASE}robots.txt`).then((r) => r.text());
  const sitemap = await fetch(`${BASE}sitemap.xml`).then((r) => r.text());
  record("robots.txt 与 sitemap.xml 存在", robots.includes("Sitemap") && sitemap.includes("urlset"), "");

  record("页面无 JS 异常", errors.length === 0, errors.slice(0, 2).join(" | "));
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
  try { await page.shot(`${OUT}/site-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/site.json`, JSON.stringify({ base: BASE, at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
