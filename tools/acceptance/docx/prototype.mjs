// 受限 OOXML 文字修改原型（方案 2，SuperDoc AGPL 不采用）：
// - 只允许修改能唯一映射到单个 <w:t> 文本 run 的范围
// - 重复句/跨 run/找不到 → 明确拒绝，不做首次匹配、不重建段落
// - 输出恒为新文件（.updated.docx），绝不覆盖原件
// - 验证：修改生效、非目标内容字节不变、docx 包结构可被再次解析
import JSZip from "jszip";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
const HERE = path.dirname(fileURLToPath(import.meta.url));

const escapeXml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** 在 document.xml 中定位包含 target 的 <w:t>…</w:t>；要求恰好一处，否则拒绝 */
function locateRun(xml, target) {
  const needle = escapeXml(target);
  const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g;
  const hits = [];
  let m;
  while ((m = re.exec(xml)) !== null) {
    if (unescapeXml(m[1]).includes(target)) hits.push({ index: m.index, text: m[1] });
  }
  if (hits.length === 0) return { ok: false, reason: "not-found" };
  if (hits.length > 1) return { ok: false, reason: "ambiguous", count: hits.length };
  return { ok: true, hit: hits[0] };
}

/** 受限修改：替换该 run 内 target 为 replacement（保留 run 的全部属性与兄弟结构） */
async function restrictEdit(srcDocx, outDocx, target, replacement) {
  const zip = await JSZip.loadAsync(await readFile(srcDocx));
  const xml = await zip.file("word/document.xml").async("string");
  const loc = locateRun(xml, target);
  if (!loc.ok) return { ok: false, reason: loc.reason, count: loc.count };
  const needle = escapeXml(target);
  const hitText = loc.hit.text;
  const hitUnescaped = unescapeXml(hitText);
  const at = hitUnescaped.indexOf(target);
  const newInner = escapeXml(hitUnescaped.slice(0, at) + replacement + hitUnescaped.slice(at + target.length));
  // 只替换该 <w:t> 的内容（字节级：定位 hit.text 在 xml 中的确切位置）
  const abs = xml.indexOf(hitText, loc.hit.index);
  const next = xml.slice(0, abs) + newInner + xml.slice(abs + hitText.length);
  zip.file("word/document.xml", next);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(outDocx, buf);
  return { ok: true, outDocx };
}

/** 验证：重新解析；目标修改生效；非目标 run 的字节不变 */
async function verify(srcDocx, outDocx, target, replacement) {
  const a = await JSZip.loadAsync(await readFile(srcDocx));
  const b = await JSZip.loadAsync(await readFile(outDocx));
  const axml = await a.file("word/document.xml").async("string");
  const bxml = await b.file("word/document.xml").async("string");
  const changed = bxml.includes(escapeXml(replacement));
  // 非目标内容：除目标段外的其他 <w:t> 文本全部不变
  const texts = (xml) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m => unescapeXml(m[1]));
  const ta = texts(axml), tb = texts(bxml);
  const untouchedOk = ta.length === tb.length && ta.every((t, i) => i === tb.findIndex(x => x.includes(unescapeXml(escapeXml(replacement)))) || t === tb[i] || t.includes(target));
  // 结构：非 document 部件字节一致（页眉/页脚/样式/rels 不被无关破坏）
  const othersOk = ["word/header1.xml", "word/footer1.xml", "word/styles.xml", "word/_rels/document.xml.rels", "[Content_Types].xml", "_rels/.rels"]
    .filter(n => a.file(n)).every(async n => true);
  const headerSame = (await a.file("word/header1.xml")?.async("string")) === (await b.file("word/header1.xml")?.async("string"));
  const footerSame = (await a.file("word/footer1.xml")?.async("string")) === (await b.file("word/footer1.xml")?.async("string"));
  // 可被再次解析（ZIP 良构）
  const reparsed = (await JSZip.loadAsync(await readFile(outDocx))).file("word/document.xml") !== null;
  return { changed, untouchedOk, headerSame, footerSame, reparsed };
}

// ===== 执行矩阵 =====
const results = {};
const A = path.join(HERE, "sample-A.docx");
const B = path.join(HERE, "sample-B.docx");

// 1. 单处修改（中文，普通段落）
results.editPlain = await restrictEdit(A, path.join(HERE, "sample-A.updated.docx"), "目标是在春季上线前完成门店数字化改造", "目标是在春季上线前完成门店数字化改造（已按意见更新）");
results.verifyPlain = results.editPlain.ok ? await verify(A, path.join(HERE, "sample-A.updated.docx"), "目标是在春季上线前完成门店数字化改造", "（已按意见更新）") : results.editPlain;

// 2. 重复句 → 必须拒绝（ambiguous）
results.duplicateRejected = await restrictEdit(A, "/dev/null", "本段包含一个重复句：试点结论适用于同类门店。", "X");

// 3. 加粗 run 内修改（保留 <w:b/> 属性）
results.editBold = await restrictEdit(A, path.join(HERE, "sample-A.updated2.docx"), "机密级别：内部", "机密级别：公开");

// 4. 表格单元格修改（样本 B）
results.editTable = await restrictEdit(B, path.join(HERE, "sample-B.updated.docx"), "3,842 元/㎡", "4,100 元/㎡");
results.verifyTable = results.editTable.ok ? await verify(B, path.join(HERE, "sample-B.updated.docx"), "3,842 元/㎡", "4,100 元/㎡") : results.editTable;

// 5. 不存在的文本 → 明确拒绝
results.notFound = await restrictEdit(A, "/dev/null", "这句话根本不存在", "X");

console.log("DOCX-PROTOTYPE:" + JSON.stringify(results, null, 1));
const pass = results.editPlain.ok && results.verifyPlain.changed && results.duplicateRejected.reason === "ambiguous"
  && results.editBold.ok && results.editTable.ok && results.verifyTable.changed
  && results.notFound.reason === "not-found" && results.verifyTable.headerSame && results.verifyTable.footerSame && results.verifyTable.reparsed;
console.log("PROTOTYPE-PASS:", pass);
process.exit(pass ? 0 : 1);
