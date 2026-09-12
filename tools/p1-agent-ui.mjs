// 体验两处：批注入口不说技术语言、Agent 接入状态是「有没有真的读过」而不是端点
// 用法: node tools/p1-agent-ui.mjs
import { openPage, openDoc, sleep } from "./p0-harness.mjs";
import { writeFile, mkdir, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// 自己起一个全新实例：Agent 读取记录是**进程内状态**，共用实例会让「未接入」那两条永远失败。
// 不传 COEDITOR_APP 时，脚本自己拉一个隔离服务（临时 vault + 临时 state），跑完关掉。
const EXTERNAL_APP = process.env.COEDITOR_APP || null;
const PORT = Number(process.env.COEDITOR_SELF_PORT || 4596);
const VAULT = "/tmp/coeditor-agent-ui/vault";
const STATE = "/tmp/coeditor-agent-ui/state";
let child = null;

async function startOwnServer() {
  if (EXTERNAL_APP) return EXTERNAL_APP;
  await mkdir(VAULT, { recursive: true });
  await rm(STATE, { recursive: true, force: true });
  await copyFile(new URL("../sample/研究设计-英文摘要.pdf", import.meta.url), join(VAULT, "研究设计-英文摘要.pdf"));
  const { spawn } = await import("node:child_process");
  const repo = fileURLToPath(new URL("..", import.meta.url));
  child = spawn(process.execPath, [join(repo, "server.mjs"), VAULT], {
    env: { ...process.env, COEDITOR_PORT: String(PORT), COEDITOR_STATE_DIR: STATE },
    stdio: "ignore", detached: false,
  });
  const app = `http://127.0.0.1:${PORT}/`;
  for (let i = 0; i < 60; i += 1) {
    if (await fetch(`${app}api/vault`).then((r) => r.ok).catch(() => false)) return app;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("自起的测试服务没起来");
}
const APP = await startOwnServer();
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
  record("弹层说明批注保存在本机", /本机|你自己电脑/.test(pop.text), pop.text.slice(0, 120));

  // 这段 JSON 普通用户不需要读，默认应收起；「复制配置」才是主路径
  const layout = await page.eval(`
    const pop = document.querySelector("#agent-pop");
    const more = pop.querySelector(".ap-more");
    const pre = pop.querySelector(".ap-code");
    const pr = pop.getBoundingClientRect();
    return { popW: Math.round(pr.width), popH: Math.round(pr.height),
             preVisible: pre ? pre.getBoundingClientRect().height > 0 : null,
             moreOpen: more ? more.open : null,
             overflowsPopover: pre ? Math.round(pre.scrollWidth - pre.clientWidth) : null,
             hasCopy: !!pop.querySelector("#agent-copy"), hasCheck: !!pop.querySelector("#agent-check"),
             help: (pop.querySelector(".ap-help") || {}).textContent || "" }; `);
  record("接入配置默认收起（不给新手看 JSON）", layout.moreOpen === false && layout.preVisible === false, JSON.stringify(layout).slice(0, 160));
  record("弹层有可读宽度，不被窄侧栏挤瘦", layout.popW >= 300, `宽 ${layout.popW}px`);
  record("按钮是「复制配置 / 检查一下」", layout.hasCopy && layout.hasCheck, "");
  record("告诉用户复制的东西贴哪里", /AI 助手|设置/.test(layout.help), layout.help.slice(0, 60));
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
if (child) child.kill();   // 只杀自己拉起来的那个
console.log(`\nPASS ${pass} / FAIL ${fail} / SKIP ${skip}（共 ${log.length} 项）`);
process.exit(fail ? 1 : 0);
