import JSZip from "../vendor/jszip.min.cjs"; // 内置副本（见 vendor/README.md）：运行时零安装
import { createHash } from 'node:crypto';
import { decodeEntities } from './xml.mjs';

const hash = b => createHash('sha256').update(b).digest('hex');
const escape = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const pattern = /<(w:t|a:t)(\s[^>]*)?>([\s\S]*?)<\/\1>/g;
export async function inspectOffice(buffer) {
  if (buffer.length > 30 * 1024 * 1024) throw new Error('暂仅支持 30MB 以下文件');
  const zip = await JSZip.loadAsync(buffer);
  const parts = Object.keys(zip.files).filter(p => /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml)$/.test(p)).sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));
  const segments = [];
  for (const part of parts) {
    const xml = await zip.file(part).async('string');
    if (xml.length > 10 * 1024 * 1024) throw new Error('文档结构过大');
    let n = 0;
    for (const m of xml.matchAll(pattern)) segments.push({ id: `${part}:${n++}`, part, text: decodeEntities(m[3]) });
  }
  return { revision: hash(buffer), segments, zip };
}
export async function patchOffice(buffer, revision, edits) {
  const doc = await inspectOffice(buffer);
  if (doc.revision !== revision) throw new Error('原文件已变化，请重新打开后修改');
  if (!Array.isArray(edits) || !edits.length) throw new Error('没有修改');
  const byId = new Map(doc.segments.map(s => [s.id, s]));
  const changes = new Map();
  for (const edit of edits) {
    if (!byId.has(edit.id) || typeof edit.text !== 'string' || edit.text.length > 100000 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(edit.text)) throw new Error('无效文字修改');
    changes.set(edit.id, edit.text);
  }
  for (const part of new Set(edits.map(e => byId.get(e.id).part))) {
    let n = 0;
    const xml = await doc.zip.file(part).async('string');
    doc.zip.file(part, xml.replace(pattern, (full, tag, attrs = '') => {
      const id = `${part}:${n++}`;
      if (!changes.has(id)) return full;
      const safeAttrs = attrs.replace(/\s+xml:space=("[^"]*"|'[^']*')/g, '');
      return `<${tag}${safeAttrs} xml:space="preserve">${escape(changes.get(id))}</${tag}>`;
    }));
  }
  return doc.zip.generateAsync({type:'nodebuffer', compression:'DEFLATE'});
}
