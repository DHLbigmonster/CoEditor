import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile, stat, rm, readdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

/* ============================================================================
 * PPTX 预览转换层：轻量核心 + 可选本地引擎
 *
 * 设计红线（产品决策，勿改）：
 *  1. 转换引擎是**可选**的本地依赖：不打包进产品、不自动安装、不联网。
 *     没有引擎就明确说「装不上/没装」，绝不给一个失真的预览充当原稿。
 *  2. 原件永不改动：转换产物只落在 .marginalia/pptx-cache/，原 .pptx 一个字节都不动。
 *  3. 批注绑的是**幻灯片身份**而不是页码：页码会随增删页漂移，sldId 不会。
 *     身份丢失时如实标「待定位」，绝不猜一个页码把批注贴上去。
 * ========================================================================== */

/** 可选引擎的候选路径。COEDITOR_SOFFICE 可显式指定，便于验证别的版本。 */
const SOFFICE_CANDIDATES = [
  process.env.COEDITOR_SOFFICE,
  "/Applications/LibreOffice.app/Contents/MacOS/soffice",
  "/opt/homebrew/bin/soffice",
  "/usr/local/bin/soffice",
  "/usr/bin/soffice",
].filter(Boolean);

export const INSTALL_HINT = "brew install --cask libreoffice";
export const INSTALL_DOWNLOAD_BYTES = 298773447; // LibreOffice 26.8.0 aarch64 dmg 实测（2026-09-07 HEAD）

/** 探测本机是否有可用的转换引擎。同步失败不抛：缺引擎是正常状态，不是异常。 */
export async function detectEngine() {
  for (const candidate of SOFFICE_CANDIDATES) {
    try {
      const info = await stat(candidate);
      if (!info.isFile() && !info.isSymbolicLink()) continue;
      let version = null;
      try {
        const { stdout } = await execFileAsync(candidate, ["--version"], { timeout: 15000 });
        version = String(stdout).trim().split("\n")[0] || null;
      } catch { /* 版本拿不到不影响转换 */ }
      return { ok: true, path: candidate, version };
    } catch { /* 换下一个候选 */ }
  }
  const env = String(process.env.COEDITOR_DISABLE_SOFFICE || "");
  return {
    ok: false,
    reason: env === "1" ? "disabled" : "not-installed",
    installHint: INSTALL_HINT,
    downloadBytes: INSTALL_DOWNLOAD_BYTES,
  };
}

/* --------------------------- 幻灯片身份（不依赖引擎） --------------------------- */

const EMU_PER_INCH = 914400;

/**
 * 从 pptx 里读出「稳定幻灯片身份」。
 * - sldId：PowerPoint 在**创建幻灯片时**分配（256、257…），重排、换模板都不变；
 *   删页后该 id 消失，新增页拿到新 id。这才是能扛住页码漂移的锚。
 * - part：ppt/slides/slideN.xml，N 会随重排变，只作辅助信息，不作主键。
 * 用系统 unzip 取条目（node 无内置解压，也不想为此引第三方依赖）。
 */
export async function readSlideIndex(absPath) {
  let presentation, rels;
  try {
    [presentation, rels] = await Promise.all([
      execFileAsync("/usr/bin/unzip", ["-p", absPath, "ppt/presentation.xml"], { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }).then(r => String(r.stdout)),
      execFileAsync("/usr/bin/unzip", ["-p", absPath, "ppt/_rels/presentation.xml.rels"], { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }).then(r => String(r.stdout)),
    ]);
  } catch (error) {
    return { slides: [], error: `无法读取 pptx 内部结构：${error?.message || error}` };
  }

  const targetByRid = new Map();
  for (const m of rels.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Target="([^"]+)"[^>]*?>/g)) {
    targetByRid.set(m[1], m[2]);
  }
  // 只认 .../relationships/slide 类型的关系：母版、notesMaster 等也挂在 presentation 上
  const slideRels = new Set();
  for (const m of rels.matchAll(/<Relationship\b[^>]*?Id="([^"]+)"[^>]*?Type="([^"]+)"[^>]*?>/g)) {
    if (/\/relationships\/slide$/i.test(m[2])) slideRels.add(m[1]);
  }

  const slides = [];
  const listMatch = presentation.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/);
  if (listMatch) {
    let order = 0;
    for (const m of listMatch[1].matchAll(/<p:sldId\b[^>]*?id="([^"]+)"[^>]*?r:id="([^"]+)"[^>]*?\/?>/g)) {
      order += 1;
      const rid = m[2];
      const target = targetByRid.get(rid) || null;
      slides.push({
        index: order,
        slideId: String(m[1]),
        part: target ? `ppt/${String(target).replace(/^\.?\//, "")}` : null,
        relKnown: target ? slideRels.has(rid) : false,
      });
    }
  }

  let sizeInches = null;
  const sz = presentation.match(/<p:sldSz\b[^>]*?cx="(\d+)"[^>]*?cy="(\d+)"/);
  if (sz) {
    sizeInches = { w: Number(sz[1]) / EMU_PER_INCH, h: Number(sz[2]) / EMU_PER_INCH };
  }
  return { slides, sizeInches, error: slides.length ? null : "未能解析 sldIdLst（文件可能损坏或不是标准 pptx）" };
}

/**
 * 取演示文稿里引用到的字体名。
 * 必须区分两类，否则主题里那一长串「回退字体池」会被当成实际使用，报出一堆没意义的缺字体：
 *   used  —— 幻灯片 XML 里**字面写死**的 typeface（+mj-lt 这类主题引用不算），这是真正影响观感的
 *   theme —— theme1.xml 的字体回退池（Segoe UI / Gautami / Nirmala UI…），只在缺字时才兜底用
 * 只读不写。
 */
export async function referencedFonts(absPath) {
  const used = new Set();
  const theme = new Set();

  const slideEntries = [];
  try {
    const listing = await execFileAsync("/usr/bin/unzip", ["-Z1", absPath, "ppt/slides/*.xml"], { timeout: 20000 }).then(r => String(r.stdout));
    for (const line of listing.split("\n")) {
      const name = line.trim();
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) slideEntries.push(name);
    }
  } catch { /* 列不出来就只知道主题 */ }

  for (const entry of slideEntries.slice(0, 200)) {
    let xml = "";
    try {
      xml = await execFileAsync("/usr/bin/unzip", ["-p", absPath, entry], { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }).then(r => String(r.stdout));
    } catch { continue; }
    for (const m of xml.matchAll(/typeface="([^"+][^"]*)"/g)) used.add(m[1]); // 跳过 "+mj-lt" 这类主题引用
  }

  try {
    const themeXml = await execFileAsync("/usr/bin/unzip", ["-p", absPath, "ppt/theme/theme1.xml"], { timeout: 20000, maxBuffer: 32 * 1024 * 1024 }).then(r => String(r.stdout));
    for (const m of themeXml.matchAll(/typeface="([^"+][^"]*)"/g)) theme.add(m[1]);
  } catch { /* 没有主题文件就算了 */ }

  return { used: [...used], theme: [...theme] };
}

/* -------------------------------- 转换与缓存 -------------------------------- */

function cacheKeyFor(absPath, info) {
  return createHash("sha256").update(`${absPath}:${info.size}:${Math.floor(info.mtimeMs)}`).digest("hex").slice(0, 24);
}

async function readManifest(dir) {
  try { return JSON.parse(await readFile(join(dir, "manifest.json"), "utf8")); } catch { return null; }
}

/**
 * 生成/复用逐页预览。
 * 返回三种状态，调用方必须分别处理，不允许把 failed/no-engine 当 ready 渲染：
 *   ready     —— 有 PDF，slides 与页数都拿到了
 *   no-engine —— 本机没有可选引擎，明确提示，绝不自动安装
 *   failed    —— 引擎在但转换失败，带上原始 stderr 供排查
 */
export async function preparePreview({ absPath, cacheRoot, force = false }) {
  // 幻灯片身份与字体清单**不依赖引擎**：即使装不上引擎，也要如实给出「这份 PPT 有几页」，
  // 而不是甩一个空白页。能不能预览是一回事，有没有读到文件是另一回事。
  const index = await readSlideIndex(absPath).catch(() => ({ slides: [], sizeInches: null, error: "读取失败" }));
  const refFonts = await referencedFonts(absPath).catch(() => ({ used: [], theme: [] }));

  const engine = await detectEngine();
  if (!engine.ok) {
    return {
      status: "no-engine",
      engine,
      slides: index.slides,
      sizeInches: index.sizeInches,
      slideError: index.error || null,
      fontsUsed: refFonts.used,
      fontsTheme: refFonts.theme.slice(0, 80),
      fontsChecked: false,
      message: "本机没有可用的 PPTX 转换引擎，无法生成逐页预览。",
      installHint: INSTALL_HINT,
      downloadBytes: INSTALL_DOWNLOAD_BYTES,
      // 明确告知：这不是 CoEditor 的缺陷，也不提供任何失真替代品
      note: "CoEditor 不会用近似渲染充当原稿，也不会替你安装软件。",
    };
  }

  const info = await stat(absPath).catch(() => null);
  if (!info) return { status: "failed", detail: "文件不存在" };
  const key = cacheKeyFor(absPath, info);
  const dir = join(cacheRoot, key);
  const pdfName = `${basename(absPath, extname(absPath))}.pdf`;

  const cached = force ? null : await readManifest(dir);
  if (cached && cached.status === "ready") {
    try { await stat(join(dir, pdfName)); return { ...cached, cached: true }; } catch { /* 产物被删，重转 */ }
  }

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });

  const warnings = [];
  const t0 = Date.now();
  try {
    // -env:UserInstallation 隔离配置目录：并发转换互不抢锁，也不污染用户自己的 LO 配置
    const { stderr } = await execFileAsync(engine.path, [
      "--headless", "--norestore", "--nolockcheck", "--invisible",
      `-env:UserInstallation=file://${join(dir, "lo-profile")}`,
      "--convert-to", "pdf:impress_pdf_Export",
      "--outdir", dir, absPath,
    ], { timeout: 180000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, HOME: process.env.HOME || "/tmp" } });
    const errText = String(stderr || "").trim();
    if (errText) {
      // LibreOffice 把字体替换 / 缺失等告警写在这里；原样带出，供上层如实提示
      for (const line of errText.split("\n").filter(Boolean).slice(0, 12)) warnings.push(line.slice(0, 300));
    }
  } catch (error) {
    return {
      status: "failed",
      engine,
      detail: "转换失败（引擎已安装但未产出 PDF）",
      stderr: String(error?.stderr || error?.message || error).slice(0, 2000),
    };
  }

  const produced = join(dir, pdfName);
  const pdfInfo = await stat(produced).catch(() => null);
  if (!pdfInfo) {
    return { status: "failed", engine, detail: "转换未产出 PDF 文件", warnings };
  }

  // index / refFonts 已在函数开头读过（不依赖引擎的那部分），此处直接复用，避免重复解压
  const manifest = {
    status: "ready",
    engine: { path: engine.path, version: engine.version },
    cacheKey: key,
    pdfName,
    pdf: { name: pdfName, bytes: pdfInfo.size },
    slides: index.slides,
    sizeInches: index.sizeInches,
    slideError: index.error || null,
    // 只把「幻灯片字面用到」的字体当缺字体候选；主题回退池单独留档，不参与告警
    fontsUsed: refFonts.used,
    fontsTheme: refFonts.theme.slice(0, 80),
    fontsChecked: false, // 字体校验是按需的：全量枚举系统字体约 7s，不能压在打开文档的路径上
    warnings,
    convertMs: Date.now() - t0,
    convertedAt: new Date().toISOString(),
    source: { bytes: info.size, mtimeMs: Math.floor(info.mtimeMs) },
  };
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { ...manifest, cached: false };
}

/**
 * 只读缓存：命中就毫秒级返回，绝不触发转换。
 * 转换是长任务（首次可能几十秒），必须由调用方放到后台任务里，
 * 不能顶在一次 HTTP 请求里——否则会被 server.requestTimeout 截断，还会堵住其它 API。
 */
export async function readCachedPreview({ absPath, cacheRoot }) {
  const info = await stat(absPath).catch(() => null);
  if (!info) return null;
  const key = cacheKeyFor(absPath, info);
  const dir = join(cacheRoot, key);
  const manifest = await readManifest(dir);
  if (!manifest || manifest.status !== "ready") return null;
  const pdfName = manifest.pdfName || manifest.pdf?.name;
  if (!pdfName) return null;
  try { await stat(join(dir, pdfName)); } catch { return null; } // 产物被删就当没缓存
  return { ...manifest, cacheKey: key, pdfName, cached: true };
}

/* ------------------------------ 字体校验（按需） ------------------------------ */

/* 为什么必须按需 + 必须缓存：
   `system_profiler SPFontsDataType -json` 在本机实测 7.5s、输出 2.1MB。
   放在「打开文档」的路径上等于每次点开 pptx 卡 7 秒，不可接受。
   所以：默认不做；用户点「检查字体」才做；结果落缓存 7 天。 */
const FONT_INDEX_TTL_MS = 7 * 24 * 3600 * 1000;
const FONT_INDEX_FILE = "_system-fonts.json";

const normFont = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

async function loadFontIndex(cacheRoot) {
  const file = join(cacheRoot, FONT_INDEX_FILE);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (Date.now() - Number(cached.builtAt || 0) < FONT_INDEX_TTL_MS && Array.isArray(cached.families)) {
      return { index: cached, fromCache: true };
    }
  } catch { /* 没缓存或缓存损坏，重建 */ }

  const families = new Set(), fullnames = new Set(), famStyles = new Set();
  const { stdout } = await execFileAsync("/usr/sbin/system_profiler", ["SPFontsDataType", "-json"], {
    timeout: 120000, maxBuffer: 256 * 1024 * 1024,
  });
  const data = JSON.parse(String(stdout));
  for (const fileEntry of Array.isArray(data?.SPFontsDataType) ? data.SPFontsDataType : []) {
    for (const tf of Array.isArray(fileEntry?.typefaces) ? fileEntry.typefaces : []) {
      if (tf.family) families.add(normFont(tf.family));
      if (tf.fullname) fullnames.add(normFont(tf.fullname));
      if (tf.family && tf.style) famStyles.add(normFont(`${tf.family} ${tf.style}`));
    }
  }
  const index = { builtAt: Date.now(), families: [...families], fullnames: [...fullnames], famStyles: [...famStyles] };
  await mkdir(cacheRoot, { recursive: true }).catch(() => {});
  await writeFile(file, JSON.stringify(index), "utf8").catch(() => {});
  return { index, fromCache: false };
}

function classifyFont(name, index) {
  const n = normFont(name);
  if (!n) return { name, status: "missing" };
  if (fullnamesHit(n, index) || index.families.includes(n) || index.famStyles.includes(n)) {
    return { name, status: "installed" };
  }
  // 「等线 Light」= 字族「等线」+ 样式 Light：字族在、样式名对不上（中文样式名/斜体差异很常见），
  // 算可用但要如实说明，不谎报「完全一致」
  const head = n.split(" ").slice(0, -1).join(" ");
  if (head && index.families.includes(head)) return { name, status: "family-only" };
  return { name, status: "missing" };
}
function fullnamesHit(n, index) { return index.fullnames.includes(n); }

/**
 * 按需检查演示文稿引用的字体在本机是否可用。
 * 失败时返回 status:"unknown" —— 拿不到就不下结论，绝不假装「都装了」。
 */
export async function checkFonts(names, { cacheRoot, refresh = false } = {}) {
  const wanted = [...new Set((names || []).map(String).filter(Boolean))].slice(0, 200);
  if (!wanted.length) return { status: "ok", checked: 0, missing: [], familyOnly: [], tookMs: 0 };
  if (!cacheRoot) return { status: "unknown", reason: "cache-root-missing", checked: 0, missing: [] };
  const t0 = Date.now();
  try {
    const file = join(cacheRoot, FONT_INDEX_FILE);
    if (refresh) await rm(file, { force: true }).catch(() => {});
    const { index, fromCache } = await loadFontIndex(cacheRoot);
    const results = wanted.map((name) => classifyFont(name, index));
    const missing = results.filter((r) => r.status === "missing").map((r) => r.name);
    const familyOnly = results.filter((r) => r.status === "family-only").map((r) => r.name);
    return {
      status: "ok",
      checked: wanted.length,
      installedCount: results.filter((r) => r.status !== "missing").length,
      missing,
      familyOnly,
      tookMs: Date.now() - t0,
      fromCache, // true=命中 7 天缓存（毫秒级）；false=刚枚举过（约 7s）
    };
  } catch (error) {
    return { status: "unknown", reason: String(error?.message || error).slice(0, 300), checked: 0, missing: [], tookMs: Date.now() - t0 };
  }
}

/** 列出缓存占用的磁盘（给用户看的数字，不做自动清理） */
export async function cacheUsage(cacheRoot) {
  let bytes = 0, entries = 0;
  try {
    for (const name of await readdir(cacheRoot)) {
      const dir = join(cacheRoot, name);
      const files = await readdir(dir).catch(() => []);
      for (const f of files) {
        const s = await stat(join(dir, f)).catch(() => null);
        if (s) bytes += s.size;
      }
      entries += 1;
    }
  } catch { /* 还没建过缓存 */ }
  return { bytes, entries };
}
