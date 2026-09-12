// 打包 CoEditor.app（自带 Node 运行时，用户不需要装任何东西）。
//
//   node tools/build-mac-app.mjs                 # 用当前 node 作为内置运行时
//   node tools/build-mac-app.mjs --node /path/to/node
//   node tools/build-mac-app.mjs --zip           # 额外产出可分发的 zip
//
// 产出：dist/CoEditor.app （双击即用）与可选 dist/CoEditor-<版本>.zip
//
// 为什么自带运行时：用户不该先理解「源码 / Node / 本地服务 / 浏览器」这一串。
// 代价是体积（内置 node 约 108MB，只依赖系统库，可独立分发）。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DIST = join(REPO, "dist");
const APP = join(DIST, "CoEditor.app");
const CONTENTS = join(APP, "Contents");
const RES = join(CONTENTS, "Resources");
const APP_DIR = join(RES, "app");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const NODE_SRC = argOf("node", process.execPath);
const WANT_ZIP = argv.includes("--zip");

const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8"));
const VERSION = pkg.version;

/** 打进包里的运行时文件（够跑产品本身；不含 tools/ 与文档） */
const RUNTIME = ["server.mjs", "cli.mjs", "mcp-stdio.mjs", "package.json", "LICENSE", "README.md"];
const RUNTIME_DIRS = ["lib", "public", "vendor"];

const log = (msg) => console.log(`  ${msg}`);

async function exists(p) {
  try { await access(p, constants.F_OK); return true; } catch { return false; }
}

console.log(`\n打包 CoEditor.app  v${VERSION}`);
console.log(`  运行时来源：${NODE_SRC}`);

// ---------- 0. 前置检查 ----------
await access(NODE_SRC, constants.X_OK).catch(() => {
  throw new Error(`找不到可执行的 node：${NODE_SRC}（用 --node 指定）`);
});
const nodeStat = await stat(NODE_SRC);
if (nodeStat.size < 5 * 1024 * 1024) throw new Error(`${NODE_SRC} 看起来不是完整的 node 二进制`);

// ---------- 1. 干净的目录结构 ----------
await rm(DIST, { recursive: true, force: true });
await mkdir(join(CONTENTS, "MacOS"), { recursive: true });
await mkdir(APP_DIR, { recursive: true });

// ---------- 2. 运行时文件 ----------
for (const file of RUNTIME) {
  await copyFile(join(REPO, file), join(APP_DIR, file));
  log(`拷入 ${file}`);
}
for (const dir of RUNTIME_DIRS) {
  await cp(join(REPO, dir), join(APP_DIR, dir), { recursive: true });
  log(`拷入 ${dir}/`);
}
// 「先看示例」需要自带素材：不联网、不要求用户先准备好文档
await cp(join(REPO, "sample"), join(APP_DIR, "sample"), { recursive: true });
log("拷入 sample/（首次打开时的示例文档）");

// ---------- 3. 内置运行时 ----------
await copyFile(NODE_SRC, join(RES, "node"));
await chmod(join(RES, "node"), 0o755);
log(`内置 node（${Math.round(nodeStat.size / 1024 / 1024)}MB）`);

// ---------- 4. 启动器 ----------
await copyFile(join(REPO, "desktop", "launcher.sh"), join(CONTENTS, "MacOS", "CoEditor"));
await chmod(join(CONTENTS, "MacOS", "CoEditor"), 0o755);
log("装入启动器");

// ---------- 5. 图标（用系统自带的 sips + iconutil，不引入依赖） ----------
const LOGO = join(REPO, "docs", "logo", "logo-512.png");
if (await exists(LOGO)) {
  const iconset = join(DIST, "AppIcon.iconset");
  await mkdir(iconset, { recursive: true });
  const sizes = [[16, "16x16"], [32, "16x16@2x"], [32, "32x32"], [64, "32x32@2x"],
    [128, "128x128"], [256, "128x128@2x"], [256, "256x256"], [512, "256x256@2x"],
    [512, "512x512"], [1024, "512x512@2x"]];
  for (const [px, name] of sizes) {
    await run("sips", ["-z", String(px), String(px), LOGO, "--out", join(iconset, `icon_${name}.png`)]);
  }
  await run("iconutil", ["-c", "icns", iconset, "-o", join(RES, "AppIcon.icns")]);
  await rm(iconset, { recursive: true, force: true });
  log("生成 AppIcon.icns");
} else {
  log(`（跳过图标：没有 ${LOGO}）`);
}

// ---------- 6. Info.plist ----------
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>CoEditor</string>
  <key>CFBundleDisplayName</key><string>CoEditor</string>
  <key>CFBundleIdentifier</key><string>com.dhlbigmonster.coeditor</string>
  <key>CFBundleExecutable</key><string>CoEditor</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHumanReadableCopyright</key><string>MIT License · https://github.com/DHLbigmonster/CoEditor</string>
</dict>
</plist>
`;
await writeFile(join(CONTENTS, "Info.plist"), plist, "utf8");
log("写入 Info.plist");

// ---------- 7. 临时签名（本机可直接双击） ----------
// 先清扩展属性：从仓库拷过来的文件带 Finder 信息/资源分叉，codesign 会直接拒绝
// （"resource fork, Finder information, or similar detritus not allowed"）。
try {
  await run("xattr", ["-cr", APP]);
  log("清理扩展属性");
} catch (error) {
  log(`（清理扩展属性失败：${String(error.stderr || error.message).split("\n")[0]}）`);
}

let signed = false;
try {
  await run("codesign", ["--force", "--deep", "--sign", "-", APP]);
  signed = true;
  log("已做本机临时签名（ad-hoc）");
} catch (error) {
  log(`（临时签名失败：${String(error.stderr || error.message).split("\n")[0]}）`);
}

// ---------- 8. 可选：分发用 zip ----------
let zipPath = null;
if (WANT_ZIP) {
  zipPath = join(DIST, `CoEditor-${VERSION}.zip`);
  // ditto 保留权限与资源分叉；GitHub 用户下载解压后仍可直接双击
  await run("ditto", ["-c", "-k", "--keepParent", APP, zipPath]);
  const zs = await stat(zipPath);
  log(`打包 ${zipPath}（${Math.round(zs.size / 1024 / 1024)}MB）`);
}

const appSize = (await run("du", ["-sh", APP])).stdout.split("\t")[0];
console.log(`\n完成：${APP}  (${appSize})`);
console.log(`  临时签名：${signed ? "是" : "否"}`);
console.log("\n下一步（对外分发前必做）：");
console.log("  1. 用开发者证书签名：codesign --force --deep --options runtime --sign \"Developer ID Application: <你的名字> (TEAMID)\" dist/CoEditor.app");
console.log("  2. 打包上传公证：ditto -c -k --keepParent dist/CoEditor.app dist/CoEditor.zip");
console.log("     xcrun notarytool submit dist/CoEditor.zip --apple-id <账号> --team-id <TEAMID> --password <专用密码> --wait");
console.log("  3. 装订票据：xcrun stapler staple dist/CoEditor.app");
console.log("  没做 1–3 时，别把「去隐私设置反复允许」写成正常安装流程。\n");
