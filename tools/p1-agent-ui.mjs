// 体验两处：批注入口不说技术语言、Agent 接入状态是「有没有真的读过」而不是端点
// 用法: node tools/p1-agent-ui.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir } from "node:fs/promises";

const APP = process.env.COEDITOR_APP || "http://127.0.0.1:4491/";
const DOC = process.env.COEDITOR_UI_DOC || "研究设计-英文摘要.pdf";
const OUT = "/tmp/coeditor-p0/evidence";

const log = [];
const record = (step, ok, detail, kind) => {
  const state = kind || (ok ? "pass" : "fail");
  log.push({ step, state, detail: detail == null ? "" : detail });
  const mark = state === "skip" ? "⏭️ " : state === "pass" ? "✅" : "❌";
  console.log(`${mark} ${step}${detail ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 240)}` : ""}`);
};

await mkdir(OUT, { recursive: true });
const page = await openPage(APP, { width: 1440, height: 900 });

try {
  await openDoc(page, DOC);

  /* ---------- 1. 批注入口不说技术语言 ---------- */
  const ph = await page.eval(`return document.querySelector('#composer-input').placeholder`);
  record("批注输入框用日常语言（「希望这里怎么改？」）", ph === "希望这里怎么改？", JSON.stringify(ph));

  const railText = await page.eval(`return (document.querySelector('.rail-foot') || {}).textContent || ''`);
  record("左栏底部不再出现 /api/constraints", !railText.includes("/api/constraints") && !railText.includes("Agent 读取："), JSON.stringify(railText.trim().slice(0, 80)));

  const bodyHasEndpoint = await page.eval(`return document.body.innerText.includes('/api/constraints')`);
  record("整个界面正文不出现接口路径", bodyHasEndpoint === false, `出现=${bodyHasEndpoint}`);

  /* ---------- 2. 未连接状态 ---------- */
  await page.eval(`try { localStorage.removeItem('coeditor.agentArmed'); } catch {} return 1;`);
  await page.navigate(APP);
  await openDoc(page, DOC);
  await sleep(600);
  const idle = await page.eval(`return { label: document.querySelector('#agent-label').textContent,
    state: document.querySelector('#btn-agent').dataset.state };`);
  record("未接入时显示「连接 Agent」", idle.label === "连接 Agent" && idle.state === "idle", JSON.stringify(idle));

  /* ---------- 3. 弹层给出可复制的接入配置 ---------- */
  const chip = await page.eval(`const b = document.querySelector('#btn-agent'); const r = b.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };`);
  await page.clickAt(chip.x, chip.y);
  await sleep(400);
  const pop = await page.eval(`const p = document.querySelector('#agent-pop');
    return { hidden: p.hidden, text: p.textContent.replace(/\\s+/g, ' ').slice(0, 160),
             snippet: (document.querySelector('#agent-snippet') || {}).textContent || '' };`);
  record("弹层打开并给出 MCP 配置", pop.hidden === false && pop.snippet.includes("mcpServers") && pop.snippet.includes("mcp-stdio.mjs"),
    JSON.stringify(pop).slice(0, 240));
  record("弹层说明批注保存在本机", pop.text.includes("本机") && pop.text.includes("annotations.json"), pop.text.slice(0, 120));
  await page.shot(`${OUT}/agent-pop.png`);

  /* ---------- 4. 有真实读取才显示「已连接」 ---------- */
  // 先确认此刻仍是未连接
  await page.eval(`document.querySelector('#agent-check').click(); return 1;`);
  await sleep(700);
  const before = await page.eval(`return document.querySelector('#agent-label').textContent`);
  record("没有读取记录时不会自称已连接", before === "连接 Agent", `实际=「${before}」`);

  // 模拟一个 Agent 真的读了一次（等价于 Agent 调用 /api/constraints）
  const readRes = await fetch(`${APP}api/constraints?p=${encodeURIComponent(DOC)}`).then((r) => r.json());
  record("约束接口可被 Agent 读取", typeof readRes.count === "number", `count=${readRes.count}`);

  await page.eval(`document.querySelector('#agent-check').click(); return 1;`);
  await sleep(800);
  const after = await page.eval(`return { label: document.querySelector('#agent-label').textContent,
    state: document.querySelector('#btn-agent').dataset.state,
    status: document.querySelector('#agent-status').textContent };`);
  record("有真实读取后变成「已连接」", after.label === "已连接" && after.state === "connected", JSON.stringify(after));
  record("状态行给出最近读取时间", /最近一次读取/.test(after.status), after.status);
  await page.shot(`${OUT}/agent-connected.png`);

  /* ---------- 5. 复制配置后进入「等待 Agent 读取」（不冒充已连接） ---------- */
  await page.eval(`try { localStorage.removeItem('coeditor.agentArmed'); } catch {} return 1;`);
  const armed = await page.eval(`
    // 直接走产品逻辑：置位 armed 并刷新（不依赖剪贴板权限）
    try { localStorage.setItem('coeditor.agentArmed', '1'); } catch {}
    return 1;`);
  await page.eval(`document.querySelector('#agent-check').click(); return 1;`);
  await sleep(600);
  const waiting = await page.eval(`return { label: document.querySelector('#agent-label').textContent,
    state: document.querySelector('#btn-agent').dataset.state };`);
  // 此时服务端已有读取记录，所以应当仍是「已连接」——证明 armed 不会覆盖真实状态
  record("已有读取记录时，armed 不会把状态降级", waiting.state === "connected", JSON.stringify(waiting));
} catch (error) {
  record("执行中断", false, String(error?.message || error), "fail");
  try { await page.shot(`${OUT}/agent-ui-fail.png`); } catch { /* ignore */ }
} finally {
  await writeFile(`${OUT}/agent-ui.json`, JSON.stringify({ at: new Date().toISOString(), log }, null, 2), "utf8");
  await page.close();
}

const pass = log.filter((l) => l.state === "pass").length;
const fail = log.filter((l) => l.state === "fail").length;
const skip = log.filter((l) => l.state === "skip").length;
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
