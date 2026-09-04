// 在页面里画「重绘版」低饱和图 → 上传 assets → 贴成画布图卡
import WebSocket from "/Users/chaos/.workbuddy/binaries/node/workspace/node_modules/ws/index.js";

const list = await (await fetch("http://127.0.0.1:9333/json/list")).json();
let page = list.find(t => t.type === "page");
const created = await (await fetch("http://127.0.0.1:9333/json/new?http://127.0.0.1:4400/?doc=%E9%85%8D%E5%9B%BE-%E6%95%B0%E5%AD%97%E5%8C%96%E4%B8%8E%E5%9D%AA%E6%95%88.png", { method: "PUT" })).json();
page = created;
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id; pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
ws.on("message", d => {
  const m = JSON.parse(d);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
});
await new Promise(r => ws.on("open", r));
await send("Page.enable"); await send("Runtime.enable");
await new Promise(r => setTimeout(r, 2500));

const js = `(async () => {
  const W = 960, H = 640;
  const c = document.createElement("canvas"); c.width = W; c.height = H;
  const g = c.getContext("2d");
  g.fillStyle = "#faf7f1"; g.fillRect(0, 0, W, H);
  // 标题
  g.fillStyle = "#3a2f26"; g.font = "bold 26px 'PingFang SC', sans-serif";
  g.fillText("数字化程度与门店坪效（重绘版 v2）", 60, 70);
  g.font = "14px 'PingFang SC', sans-serif"; g.fillStyle = "#8a7d6f";
  g.fillText("虚线为按批注 A-0001 降一档饱和度后的柱色 · 数据与原版一致", 60, 98);
  // 数据（与原版一致）
  const labels = ["2024Q1","2024Q2","2024Q3","2024Q4","2025Q1","2025Q2","2025Q3","2025Q4"];
  const bars = [0.32, 0.38, 0.45, 0.52, 0.60, 0.68, 0.78, 0.86];
  const line = [5.9, 6.0, 6.1, 6.15, 6.25, 6.35, 6.5, 6.62];
  const x0 = 90, y0 = 540, bw = 46, gap = (W - 200 - bw*8) / 7;
  const lo = 5.8, hi = 6.7;
  // 降饱和柱色（陶土 → 灰陶）
  const cols = ["#c9bcae","#c2b3a3","#baa998","#b19f8d","#a89583","#9e8b78","#937f6b","#87735f"];
  bars.forEach((v, i) => {
    const h = v * 360, x = x0 + i * (bw + gap);
    g.fillStyle = cols[i]; g.fillRect(x, y0 - h, bw, h);
    g.fillStyle = "#8a7d6f"; g.font = "12px 'PingFang SC', sans-serif";
    g.fillText(labels[i], x - 4, y0 + 20);
  });
  // 折线（坪效对数）
  g.strokeStyle = "#6b5a48"; g.lineWidth = 2.5; g.beginPath();
  line.forEach((v, i) => {
    const x = x0 + i * (bw + gap) + bw / 2;
    const y = y0 - ((v - lo) / (hi - lo)) * 330 - 30;
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  });
  g.stroke();
  line.forEach((v, i) => {
    const x = x0 + i * (bw + gap) + bw / 2;
    const y = y0 - ((v - lo) / (hi - lo)) * 330 - 30;
    g.fillStyle = "#6b5a48"; g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill();
  });
  // 图例
  g.fillStyle = "#8a7d6f"; g.font = "13px 'PingFang SC', sans-serif";
  g.fillText("■ 数字化指数（降饱和）   ── 坪效对数", 60, 600);
  const blob = await new Promise(r => c.toBlob(r, "image/png"));
  const buf = await blob.arrayBuffer();
  const up = await fetch("/api/asset?name=" + encodeURIComponent("重绘版-数字化与坪效-v2.png") + "&dir=assets", { method: "POST", body: buf });
  const upj = await up.json();
  const post = await fetch("/api/canvas/images", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ x: 760, y: 470, w: 300, file: upj.rel, doc: "配图-数字化与坪效.png" }) });
  const postj = await post.json();
  return JSON.stringify({ up: upj.rel, card: postj });
})()`;
const ev = await send("Runtime.evaluate", { expression: js, returnByValue: true, awaitPromise: true });
console.log("RESULT:", JSON.stringify(ev.result?.result?.value ?? ev.result));
await fetch(`http://127.0.0.1:9333/json/close/${page.id}`).catch(() => {});
ws.close(); process.exit(0);
