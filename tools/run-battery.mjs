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
  env: { ...process.env, COEDITOR_PORT: String(PORT) },
  stdio: "ignore",
});
let ready = false;
for (let i = 0; i < 30; i += 1) {
  try { await (await fetch(`${BASE}/api/tree`)).json(); ready = true; break; } catch { await sleep(300); }
}
if (!ready) { console.error("❌ 隔离服务启动失败"); process.exit(2); }
console.log(`\n🧪 CoEditor 测试电池 → ${BASE}（vault: ${VAULT}）\n`);

// 套件清单：[名称, 脚本, 通过判据(对 stdout 的正则数组, 条数为出现次数下限)]
const suites = [
  ["真实输入：md/PDF 选区·高亮·编辑·文件夹选择器", "eval-real-input.mjs", [["noPan\": true", 1], ["menuShown\": true", 2], ["markInDoc\": true", 1], ["editing\": true", 1], ["fsClosed\": true", 1]]],
  ["PDF 区域框选：拖框→面板→保存→切列复位", "eval-pdf-region.mjs", [["shown\": true", 1], ["overlaySurvivesCols\": true", 1], ["lineDrawn\": true", 1]]],
  ["格式选区：docx / HTML", "eval-formats.mjs", [["menuShown\": true", 2]]],
  ["画布工具：箭头 / 便签 / 白板", "eval-canvas-tools.mjs", [["arrowCreated\": true", 1], ["noteCreated\": true", 1], ["boardCreated\": true", 1]]],
  ["PDF 长文档按需渲染", "eval-pdf-lazy.mjs", [["lazyWorked\": true", 1], ["textComplete\": true", 1]]],
  ["HTML 双击直改：写回纯净 + 批注重锚定", "eval-html-inline-edit.mjs", [["panelShown\": true", 1], ["fileHasNewText\": true", 1], ["noRawUrl\": true", 1], ["annotationReanchored\": true", 1], ["restored\": true", 1]]],
  ["vault 切换守卫：不虚推进批次", "eval-vault-guard.mjs", [["guardWorked\": true", 1]]],
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
