// 构造合成 DOCX 样本（零依赖手写 OOXML，覆盖：段落/加粗混排/中文/超链接/表格/编号列表/页眉页脚）
// 图片样本涉及 media+rels，标注为本原型未覆盖项
import JSZip from "jszip";
import { writeFile, mkdir } from "node:fs/promises";

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>
<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
const docRels = (withHeaderFooter) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${withHeaderFooter ? '<Relationship Id="rIdH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>\n<Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>' : ''}
</Relationships>`;
const run = (text, bold = false) => `<w:r>${bold ? "<w:rPr><w:b/></w:rPr>" : ""}<w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (content) => `<w:p>${content}</w:p>`;
const numPr = `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>`;

const documentXml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr/></w:body></w:document>`;

// 样本 A：段落 + 加粗混排 + 中文 + 超链接（纯文本展示，关系表内含 hyperlink 关系）
async function sampleA() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", documentXml(
    para(run("项目简报：山月斋数字化试点（", false) + run("机密级别：内部", true) + run("）", false)) +
    para(run("目标是在春季上线前完成门店数字化改造，并沉淀可复用的运营 SOP。", false)) +
    para(run("本段包含一个重复句：试点结论适用于同类门店。", false)) +
    para(run("本段包含一个重复句：试点结论适用于同类门店。", false))
  ));
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(new URL("./sample-A.docx", import.meta.url), buf);
}

// 样本 B：表格 + 页眉页脚 + 编号列表
async function sampleB() {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  const table = `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
    <w:tr><w:tc><w:tcPr/><w:p>${run("门店", true)}</w:tc><w:tc><w:tcPr/><w:p>${run("坪效")}</w:tc></w:tr>
    <w:tr><w:tc><w:tcPr/><w:p>${run("旗舰店")}</w:tc><w:tc><w:tcPr/><w:p>${run("3,842 元/㎡")}</w:tc></w:tr></w:tbl>`;
  const numbered = para(numPr + run("第一步：盘点现状。")) + para(numPr + run("第二步：制定改造计划。"));
  zip.file("word/document.xml", documentXml(table + numbered + para(run("表格之外的结尾段落。"))));
  zip.file("word/_rels/document.xml.rels", docRels(true));
  zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${run("山月斋 · 内部文件")}</w:p></w:hdr>`);
  zip.file("word/footer1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p>${run("第 1 页")}</w:p></w:ftr>`);
  zip.file("word/styles.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"></w:styles>`);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(new URL("./sample-B.docx", import.meta.url), buf);
}

await mkdir(new URL("./", import.meta.url), { recursive: true });
await sampleA();
await sampleB();
console.log("样本已生成：sample-A.docx（段落/加粗/中文/重复句）、sample-B.docx（表格/编号列表/页眉页脚）");
