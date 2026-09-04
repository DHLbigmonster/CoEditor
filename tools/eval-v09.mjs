// v0.9 回归：VS Code 式树折叠、批注显示号/编辑/删除、图片区域单次生成、画布元素显式删除。
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";
import { existsSync } from "node:fs";

const BASE = process.env.COEDITOR_E2E_BASE || "http://127.0.0.1:4401";
const VAULT = process.env.COEDITOR_E2E_COPY || "/tmp/coeditor-battery";
const DOC = "研究设计笔记.md";
const api = async (url, options = {}) => {
  const response = await fetch(`${BASE}${url}`, options);
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status} ${url}: ${JSON.stringify(json)}`);
  return json;
};
const jsonOptions = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const created = await api(`/api/annotations?p=${encodeURIComponent(DOC)}`, jsonOptions("POST", {
  kind: "text", quote: "研究设计", prefix: "", suffix: "", body: "测试：这条批注需要编辑", x: 850, y: 80,
}));

const targets = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = targets.find((target) => target.type === "page" && (target.url || "").startsWith(BASE));
if (!page) page = await (await fetch(`http://127.0.0.1:9333/json/new?${BASE}`, { method: "PUT" })).json();
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const callId = ++id; pending.set(callId, { resolve, reject });
  ws.send(JSON.stringify({ id: callId, method, params }));
});
ws.on("message", (data) => {
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const call = pending.get(message.id); pending.delete(message.id);
  message.error ? call.reject(new Error(JSON.stringify(message.error))) : call.resolve(message.result);
});
await new Promise((resolve) => ws.on("open", resolve));
await send("Page.enable"); await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const evaluate = async (expression) => {
  const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (value.exceptionDetails) throw new Error(JSON.stringify(value.exceptionDetails).slice(0, 500));
  return value.result?.value;
};
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x), y: Math.round(y), button: "left", buttons: 1, clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x), y: Math.round(y), button: "left", buttons: 0, clickCount: 1 });
};
const drag = async (x1, y1, x2, y2) => {
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: Math.round(x1), y: Math.round(y1), button: "left", buttons: 1, clickCount: 1 });
  for (let step = 1; step <= 10; step += 1) await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: Math.round(x1 + (x2 - x1) * step / 10), y: Math.round(y1 + (y2 - y1) * step / 10), button: "left", buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: Math.round(x2), y: Math.round(y2), button: "left", buttons: 0, clickCount: 1 });
};

await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(DOC)}` });
await sleep(1800);

// 文件树：真实点击顶层文件夹，验证 aria-expanded 与子树显隐，再恢复展开。
const treeBefore = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.tree-node > .dir')].find((item) => item.textContent.includes('读书笔记'));
  if (!row) return null;
  const rect = row.getBoundingClientRect();
  return { x: rect.left + 18, y: rect.top + rect.height / 2, expanded: row.getAttribute('aria-expanded') };
})()`);
if (treeBefore) await click(treeBefore.x, treeBefore.y);
await sleep(250);
const treeCollapsed = await evaluate(`(() => {
  const row = [...document.querySelectorAll('.tree-node > .dir')].find((item) => item.textContent.includes('读书笔记'));
  return !!row && row.getAttribute('aria-expanded') === 'false' && getComputedStyle(row.parentElement.querySelector(':scope > .tree-children')).display === 'none';
})()`);
if (treeBefore) await click(treeBefore.x, treeBefore.y);

// 卡片：真实点“编辑”，改内容并保存，再真实点“删除”。
await evaluate(`document.querySelector('.card[data-id="${created.annotation.id}"]').scrollIntoView({block:'center'})`);
await sleep(250);
const editPoint = await evaluate(`(() => { const b = document.querySelector('.card[data-id="${created.annotation.id}"] [data-act="edit"]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
await click(editPoint.x, editPoint.y);
await sleep(180);
const editOpened = await evaluate(`!!document.querySelector('.card[data-id="${created.annotation.id}"] .card-edit')`);
await evaluate(`document.querySelector('.card[data-id="${created.annotation.id}"] .card-edit').value='测试：批注已成功编辑'`);
const savePoint = await evaluate(`(() => { const b=document.querySelector('.card[data-id="${created.annotation.id}"] .c-actions button.primary'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
await click(savePoint.x, savePoint.y);
await sleep(650);
const afterEdit = await api(`/api/annotations?p=${encodeURIComponent(DOC)}`);
const editPersisted = afterEdit.annotations.find((item) => item.id === created.annotation.id)?.body === "测试：批注已成功编辑";
const visibleNo = await evaluate(`document.querySelector('.card[data-id="${created.annotation.id}"] .c-id')?.textContent || ''`);
const deletePoint = await evaluate(`(() => { const b=document.querySelector('.card[data-id="${created.annotation.id}"] [data-act="delete"]'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
await click(deletePoint.x, deletePoint.y);
await sleep(650);
const afterDelete = await api(`/api/annotations?p=${encodeURIComponent(DOC)}`);
const deletePersisted = !afterDelete.annotations.some((item) => item.id === created.annotation.id);

// 图片区域：连续事件只应生成一个 draft/一条批注，保存后框与牵引线各一份。
const IMAGE_DOC = "配图-数字化与坪效.png";
const regionBefore = await api(`/api/annotations?p=${encodeURIComponent(IMAGE_DOC)}`);
await send("Page.navigate", { url: `${BASE}/?doc=${encodeURIComponent(IMAGE_DOC)}` });
await sleep(1600);
const imageRect = await evaluate(`(() => { const s=document.getElementById('image-stage'); const r=s.getBoundingClientRect(); return {x:r.left+r.width*.25,y:r.top+r.height*.25,x2:r.left+r.width*.48,y2:r.top+r.height*.43}; })()`);
await drag(imageRect.x, imageRect.y, imageRect.x2, imageRect.y2);
await sleep(250);
const oneComposer = await evaluate(`!document.getElementById('composer').hidden && document.querySelectorAll('.region-draft').length === 0`);
await evaluate(`document.getElementById('composer-input').value='测试：只生成一个区域'`);
const composerSave = await evaluate(`(() => { const b=document.getElementById('composer-save'); const r=b.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
await click(composerSave.x, composerSave.y);
await sleep(900);
const regionAfter = await api(`/api/annotations?p=${encodeURIComponent(IMAGE_DOC)}`);
const newRegions = regionAfter.annotations.filter((item) => item.kind === "region" && !regionBefore.annotations.some((old) => old.id === item.id));
const regionDom = newRegions.length === 1 ? await evaluate(`(() => ({ boxes: document.querySelectorAll('.region[data-ann="${newRegions[0].id}"]').length, lines: document.querySelectorAll('#lines path[data-ann="${newRegions[0].id}"]').length }))()`) : { boxes: 0, lines: 0 };

// 显式删除画布图卡必须被允许，同时其他集合数量不得受影响。
const imageCard = await api("/api/canvas/images", jsonOptions("POST", { file: "配图-数字化与坪效.png", x: 20, y: 20, w: 160, doc: IMAGE_DOC }));
const canvasBeforeDelete = await api("/api/canvas/images");
await api(`/api/canvas/images?id=${encodeURIComponent(imageCard.image.id)}`, { method: "DELETE" });
const canvasAfterDelete = await api("/api/canvas/images");

console.log("V09:", JSON.stringify({
  treeCollapsed,
  visibleNoPattern: /^\d+-\d+$/.test(visibleNo),
  displayNoMatchesApi: visibleNo === created.annotation.no,
  editOpened,
  editPersisted,
  deletePersisted,
  backupExists: existsSync(`${VAULT}/.marginalia/annotations.json.prev`),
  oneComposer,
  oneRegionCreated: newRegions.length === 1,
  oneRegionBox: regionDom.boxes === 1,
  oneRegionLine: regionDom.lines === 1,
  canvasDeleteWorked: canvasAfterDelete.images.length === canvasBeforeDelete.images.length - 1,
}, null, 2));
ws.close();
