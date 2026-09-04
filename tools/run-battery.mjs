// 一键测试电池：备 vault → 起隔离服务(4401) → 顺序跑全部 E2E → 汇总 ✅/❌ 报告
// 用法：node tools/run-battery.mjs   （需 headless Chrome 9333 常驻）
// 退出码 0 = 全绿；非 0 = 有失败（CI 可用）
import { spawn, execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 4401;
const BASE = `http://127.0.0.1:${PORT}`;
const VAULT = "/tmp/coeditor-battery";
const AWAY = "/tmp/coeditor-battery-away";

process.env.COEDITOR_E2E_BASE = BASE;
process.env.COEDITOR_E2E_COPY = VAULT;
process.env.COEDITOR_E2E_BASE_VAULT = VAULT;
process.env.COEDITOR_E2E_AWAY = AWAY;
process.env.COEDITOR_LONG_PDF_OUT = `${VAULT}/长文档测试-12页.pdf`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 前置检查：headless Chrome 9333
try {
  await (await fetch("http://127.0.0.1:9333/json/version")).json();
} catch {
  console.error("❌ 需要 headless Chrome (127.0.0.1:9333)。启动示例：");
  console.error('   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 --user-data-dir=/tmp/marginalia-cdp-profile --no-first-run --no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage --disable-gpu about:blank');
  process.exit(2);
}

// 备 vault（copy of copy：绝不写入仓库内的 sample）
rmSync(VAULT, { recursive: true, force: true });
cpSync(path.join(ROOT, "sample"), VAULT, { recursive: true });
rmSync(AWAY, { recursive: true, force: true });
process.env.COEDITOR_E2E_BASE_VAULT = VAULT;

// 生成 12 页长文档（pdf-lazy 依赖）
execFileSync(process.execPath, [path.join(HERE, "make-long-pdf.mjs")], { stdio: "inherit", timeout: 60000 });

// 起隔离服务
const server = spawn(process.execPath, [path.join(ROOT, "server.mjs"), VAULT], {
  env: { ...process.env, COEDITOR_PORT: String(PORT), COEDITOR_DISABLE_NATIVE_PICKER: "1" },
  stdio: "ignore",
});
let ready = false;
for (let i = 0; i < 30; i += 1) {
  try {
    const tree = await (await fetch(`${BASE}/api/tree`)).json();
    if (tree.root === VAULT) { ready = true; break; } // 必须是「我们的」服务：端口残留实例的 root 不符
  } catch { await sleep(300); }
}
if (!ready) { console.error(`❌ 隔离服务启动失败（端口 ${PORT} 被其他实例占用或 root 不符）`); server.kill(); process.exit(2); }

// 激活目标页到前台：后台标签被浏览器节流（IntersectionObserver 不触发 → PDF 惰性渲染不推进；
// 定时器降频 → docx 解析/浮条来不及出），会让只改了测试文件的正常代码「大面积回归」。
try {
  const tabs = await (await fetch("http://127.0.0.1:9333/json/list")).json();
  const base = tabs.find((t) => t.type === "page" && (t.url || "").startsWith(BASE));
  const target = base || await (await fetch(`http://127.0.0.1:9333/json/new?${BASE}`, { method: "PUT" })).json();
  if (target?.id) await fetch(`http://127.0.0.1:9333/json/activate/${target.id}`);
} catch { /* 激活失败不致命，继续跑 */ }
console.log(`\n🧪 CoEditor 测试电池 → ${BASE}（vault: ${VAULT}）\n`);

// 套件清单：[名称, 脚本, 通过判据(对 stdout 的正则数组, 条数为出现次数下限)]
const suites = [
  ["真实输入：md/PDF 选区·保留·编辑·文件夹选择器", "eval-real-input.mjs", [["noPan\": true", 1], ["menuShown\": true", 2], ["markInDoc\": true", 1], ["noConnector\": true", 1], ["visibleNoPattern\": true", 1], ["retainLabel\": true", 1], ["textLayerTransparent\": true", 1], ["editing\": true", 1], ["fsClosed\": true", 1]]],
  ["PDF 区域框选：拖框→面板→保存→切列复位", "eval-pdf-region.mjs", [["shown\": true", 1], ["overlaySurvivesCols\": true", 1], ["lineDrawn\": true", 1]]],
  ["格式选区：docx / HTML", "eval-formats.mjs", [["menuShown\": true", 2]]],
  ["画布工具：箭头 / 图片独立拖动 / 工具条固定", "eval-canvas-tools.mjs", [["arrowCreated\": true", 1], ["imageMoved\": true", 1], ["canvasStayed\": true", 1], ["storedMove\": true", 1], ["toolboxCentered\": true", 1], ["toolboxAtBottom\": true", 1], ["obsoleteToolsGone\": true", 1]]],
  ["PDF 长文档按需渲染", "eval-pdf-lazy.mjs", [["lazyWorked\": true", 1], ["textComplete\": true", 1]]],
  ["HTML 双击直改：写回纯净 + 批注重锚定", "eval-html-inline-edit.mjs", [["panelShown\": true", 1], ["fileHasNewText\": true", 1], ["noRawUrl\": true", 1], ["annotationReanchored\": true", 1], ["restored\": true", 1]]],
  ["vault 切换守卫：不虚推进批次", "eval-vault-guard.mjs", [["guardWorked\": true", 1]]],
  ["v0.9：树折叠 / 批注编辑删除 / 图片区域防重复", "eval-v09.mjs", [["treeCollapsed\": true", 1], ["visibleNoPattern\": true", 1], ["displayNoMatchesApi\": true", 1], ["editOpened\": true", 1], ["editPersisted\": true", 1], ["deletePersisted\": true", 1], ["oneRegionCreated\": true", 1], ["oneRegionBox\": true", 1], ["oneRegionLine\": true", 1], ["canvasDeleteWorked\": true", 1]]],
  ["v0.9.2：新建文档 / 成品定位源码 / MCP resolve 闭环 / 顶栏减负", "eval-v092.mjs", [["apiCreated\": true", 1], ["dupBlocked\": true", 1], ["traversalSanitized\": true", 1], ["resolveMarked\": true", 1], ["constraintsDropped\": true", 1], ["editSplitShown\": true", 1], ["clickLocated\": true", 1], ["selectionLocated\": true", 1], ["uiCreated\": true", 1], ["uiEditOpened\": true", 1], ["topbarLean\": true", 1]]],
];

const results = [];
for (const [name, script, criteria] of suites) {
  let out = "";
  let threw = null;
  const t0 = Date.now();
  try {
    out = execFileSync(process.execPath, [path.join(HERE, script)], { encoding: "utf8", timeout: 180000, env: process.env });
  } catch (err) {
    threw = String(err.message).slice(0, 160);
    out = err.stdout || "";
  }
  // 冒号后空格可选：脚本 JSON 输出有无缩进两种格式（": true" 与 ":true"）都要命中
  const failed = criteria.filter(([needle, min]) => (out.match(new RegExp(needle.replace(/"/g, '\\"').replace(/: /g, ":\\s*"), "g")) || []).length < min)
    .map(([needle]) => needle);
  results.push({ name, ok: !threw && failed.length === 0, threw, failed, ms: Date.now() - t0 });
  process.stdout.write(`${results[results.length - 1].ok ? "✅" : "❌"} ${name} (${results[results.length - 1].ms}ms)${failed.length ? " → 未满足: " + failed.join(", ") : ""}${threw ? " → " + threw : ""}\n`);
  if (results[results.length - 1].ok === false) {
    process.stdout.write("   └─ stdout 尾部: " + JSON.stringify(out.slice(-400)) + "\n");
  }
}

server.kill();
rmSync(VAULT, { recursive: true, force: true });
rmSync(AWAY, { recursive: true, force: true });

const passed = results.filter((r) => r.ok).length;
console.log(`\n📊 ${passed}/${results.length} 套件通过${passed === results.length ? " —— 发布门禁通过" : " —— 存在失败，禁止发布"}`);
process.exit(passed === results.length ? 0 : 1);
