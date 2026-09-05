// 逐步复刻：定位「长文档 PDF 在哪个套件后消失」
import { spawn, execFileSync } from "node:child_process";
import { cpSync, rmSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, "..");
const VAULT = "/tmp/coeditor-step-vault";
const PDF = `${VAULT}/长文档测试-12页.pdf`;
const NODE = process.execPath;
const PORT = 4401;

let lastTree = "未查询";
const check = async (label) => {
  const ok = existsSync(PDF);
  try { lastTree = String(await (await fetch(`http://127.0.0.1:${PORT}/api/tree`)).json().then(d => JSON.stringify(d.tree)).catch(e => "err:" + e)); } catch {}
  const treeHas = lastTree.includes("长文档测试-12页.pdf");
  console.log(`${ok ? "在" : "消失"} / tree:${treeHas ? "在" : "无"}  [${label}]`);
  return ok;
};

rmSync(VAULT, { recursive: true, force: true });
cpSync(path.join(ROOT, "sample"), VAULT, { recursive: true });
process.env.COEDITOR_E2E_BASE = `http://127.0.0.1:${PORT}`;
process.env.COEDITOR_E2E_COPY = VAULT;
process.env.COEDITOR_E2E_AWAY = "/tmp/coeditor-step-away";
process.env.COEDITOR_LONG_PDF_OUT = PDF;
mkdirSync(path.join(VAULT, ".marginalia"), { recursive: true });

execFileSync(NODE, [path.join(HERE, "make-long-pdf.mjs")], { stdio: "inherit", timeout: 60000 });
await check("$1");

const server = spawn(NODE, [path.join(ROOT, "server.mjs"), VAULT], { env: { ...process.env, COEDITOR_PORT: String(PORT) }, stdio: "ignore" });
await new Promise(r => setTimeout(r, 1500));
await check("$1");

const run = (script) => {
  try { execFileSync(NODE, [path.join(HERE, script)], { encoding: "utf8", timeout: 200000, env: process.env, stdio: ["ignore", "pipe", "pipe"] }); }
  catch (err) { console.log(`  (${script} 异常: ${String(err.message).slice(0, 60)})`); }
};

await check("$1"); run("eval-real-input.mjs"); await check("$1");
run("eval-pdf-region.mjs"); await check("$1");
run("eval-formats.mjs"); await check("$1");
run("eval-v092.mjs"); await check("$1");

server.kill();
rmSync(VAULT, { recursive: true, force: true });
process.exit(0);
