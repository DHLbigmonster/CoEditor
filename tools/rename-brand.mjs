// 品牌 rename：Marginalia → CoEditor（保留数据目录 .marginalia 与 PDF/截图等二进制）
import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "README.md",
  "public/index.html",
  "public/app.js",
  "package.json",
  "server.mjs",
  "mcp-stdio.mjs",
  "cli.mjs",
  "sample/研究设计笔记.md",
  "sample/研究设计笔记-改写提案.md",
  "sample/.marginalia/annotations.json",
  "tools/shoot.mjs",
  "tools/make-redraw.mjs",
];

const DOT = "__DOT_MARGINALIA__";
for (const f of files) {
  let t = readFileSync(f, "utf8");
  const before = t;
  t = t.replaceAll(".marginalia", DOT);          // 保护数据目录名
  t = t.replaceAll("MARGINALIA_PORT", "__ENV_PORT__"); // 保护环境变量名（下面单独处理）
  t = t.replaceAll("Marginalia", "CoEditor");
  t = t.replaceAll("marginalia", "coeditor");    // 命令名 / serverInfo name / clone 目录
  t = t.replaceAll("__ENV_PORT__", "COEDITOR_PORT");
  t = t.replaceAll(DOT, ".marginalia");          // 还原数据目录
  if (t !== before) {
    writeFileSync(f, t);
    console.log("renamed:", f);
  }
}
console.log("done");
