// P0 真机测试台：Chrome + CDP，全部输入走 Input.*（真实浏览器事件，不是 JS .click()）
//
// 为什么必须这样：规格 §B01/B02 明确禁止「直接给 state 注入合成数据再断言」。
// 这里每一步都是真实鼠标按下/移动/抬起 + 真实键盘插入，事件链与用户操作一致。
//
// 用法：被 tools/p0-*.mjs 引入。也支持 `node tools/p0-harness.mjs` 自检 CDP 连通性。
import WebSocket from "ws";
import { writeFileSync } from "node:fs";

const HTTP = process.env.COEDITOR_CDP_HTTP || "http://127.0.0.1:9333";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function openPage(url, { width = 1440, height = 900 } = {}) {
  const created = await fetch(`${HTTP}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then((r) => r.json());
  const ws = new WebSocket(created.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
  let seq = 0;
  const pending = new Map();
  const listeners = [];

  ws.on("message", (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const slot = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? slot.reject(new Error(JSON.stringify(msg.error))) : slot.resolve(msg.result);
      return;
    }
    for (const fn of listeners) fn(msg);
  });

  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  // 必须禁缓存：否则改完 app.js 后浏览器仍跑旧脚本，会让「修好了/没修好」的判断完全失真
  await send("Network.enable").catch(() => {});
  await send("Network.setCacheDisabled", { cacheDisabled: true }).catch(() => {});
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });

  const page = {
    targetId: created.id,
    onEvent: (fn) => listeners.push(fn),
    async eval(expression, { awaitPromise = true } = {}) {
      const result = await send("Runtime.evaluate", {
        // async IIFE：允许页面内表达式直接 await（诊断脚本要 fetch API 比对）
        expression: `(async () => { ${expression} })()`,
        returnByValue: true,
        awaitPromise,
      });
      if (result.exceptionDetails) {
        throw new Error(`页面内异常: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`);
      }
      return result.result.value;
    },
    async navigate(target) {
      await send("Page.navigate", { url: target });
      await sleep(1200);
    },
    /** 真实鼠标：按下→移动→抬起 */
    async mouse(type, x, y, { button = "left", clickCount = 1, modifiers = 0 } = {}) {
      await send("Input.dispatchMouseEvent", { type, x: Math.round(x), y: Math.round(y), button, clickCount, modifiers });
    },
    async clickAt(x, y, options) {
      await page.mouse("mousePressed", x, y, options);
      await sleep(40);
      await page.mouse("mouseReleased", x, y, options);
    },
    async drag(from, to, { steps = 12 } = {}) {
      await page.mouse("mousePressed", from.x, from.y);
      for (let i = 1; i <= steps; i += 1) {
        const t = i / steps;
        await page.mouse("mouseMoved", from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, { button: "left" });
        await sleep(16);
      }
      await page.mouse("mouseReleased", to.x, to.y, { button: "left" });
      await sleep(120);
    },
    /** 捏合缩放（modifiers=2 是 Ctrl 位）。deltaMode: 0=像素 1=行 2=页 */
    async wheelZoom(x, y, deltaY, deltaMode = 0) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: Math.round(x), y: Math.round(y),
        deltaX: 0, deltaY, deltaMode, modifiers: 2, pointerType: "mouse",
      });
    },
    /** 真实滚动合成（比裸 wheel 事件更接近触控板：Chrome 会真的滚动容器） */
    async scrollGesture(x, y, yDistance, { speed = 800 } = {}) {
      await send("Input.synthesizeScrollGesture", {
        x: Math.round(x), y: Math.round(y), xDistance: 0, yDistance, speed, gestureSourceType: "default",
      });
    },
    /** 普通双指滚动 */
    async wheelPlain(x, y, deltaY, deltaMode = 0) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: Math.round(x), y: Math.round(y),
        deltaX: 0, deltaY, deltaMode, modifiers: 0, pointerType: "mouse",
      });
    },
    async type(text) {
      await send("Input.insertText", { text });
    },
    async key(key, { code = "", keyCode = 0, modifiers = 0, type = "keyDown" } = {}) {
      await send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
    },
    async shot(path) {
      const { data } = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      writeFileSync(path, Buffer.from(data, "base64"));
      return path;
    },
    async waitFor(expression, { timeout = 15000, label = expression } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const value = await page.eval(expression).catch(() => null);
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`等待超时: ${label}`);
        await sleep(250);
      }
    },
    async close() {
      try { await fetch(`${HTTP}/json/close/${created.id}`); } catch { /* 已关闭 */ }
      ws.close();
    },
  };

  await sleep(900); // 首屏脚本
  return page;
}

/** 选中文件并等到「正文真的切过去了」再返回。
    为什么必须等：应用会恢复「最近打开」的文档，若只等 .textLayer span 出现，
    旧文档的文字层同样满足条件，后续拖选就会落在错误的页面上（实测导致间歇性假失败）。 */
/** 等 PDF 停止重建：实测打开一份 PDF 会重建 3 次，期间页 DOM 被替换、几何在变。
    在重建窗口里取到的 span 坐标是过期的，拖选会落到空白处（实测间歇性假失败）。 */
export async function waitDocSettled(page, { timeout = 25000 } = {}) {
  const deadline = Date.now() + timeout;
  let prev = "";
  while (Date.now() < deadline) {
    const sig = await page.eval(`
      const doc = document.querySelector('#doc');
      const first = doc.querySelector('.pdf-page');
      if (first && !first.dataset.settleProbe) first.dataset.settleProbe = String(Math.random()).slice(2, 9);
      const p = doc.querySelector('.pdf-page');
      return [p ? p.dataset.settleProbe : 'none',
              doc.querySelectorAll('.pdf-page').length,
              doc.querySelectorAll('.pdf-page .textLayer span').length,
              p ? Math.round(p.getBoundingClientRect().width) : 0].join('|');`).catch(() => "");
    if (sig && sig === prev) return sig;
    prev = sig;
    await sleep(450);
  }
  return prev;
}

export async function openDoc(page, doc) {
  const rowExpr = `const row = document.querySelector('[data-path="${doc}"]');
    if (!row) return null; row.scrollIntoView({ block: 'center' });
    const r = row.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };`;
  const tree = await page.waitFor(rowExpr, { label: "文件树出现" });
  await page.clickAt(tree.x, tree.y);
  await page.waitFor(`return (document.querySelector('#docpath') ? document.querySelector('#docpath').textContent : '').includes(${JSON.stringify(doc)})`,
    { label: `正文切到 ${doc}` });
  // 阈值取 5 而不是 20：1 页的短文档文字层只有十几个 span（实测英文摘要 18 个），
  // 用 20 当门槛会把正常文档误判成「没渲染出来」。
  await page.waitFor(`return document.querySelectorAll('#doc .pdf-page .textLayer span').length > 5`, { label: "PDF 文字层" });
  await waitDocSettled(page);
  return tree;
}

export { sleep };

if (import.meta.url === `file://${process.argv[1]}`) {
  const version = await fetch(`${HTTP}/json/version`).then((r) => r.json());
  console.log("CDP 可用:", version.Browser);
  const page = await openPage("about:blank");
  console.log("页面 eval 自检:", await page.eval("return 1 + 1"));
  await page.close();
}
