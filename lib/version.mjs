// 版本对照：Agent 改完文档后登记新版本，人在这里验收 / 退回，并可继续在新版本上批注。
// 原则与全文一致：原件永不被覆盖，新版本是旁边的新文件。
//
// v0.9.10 可信化改造：
// - 每个版本有不可变 id，验收按 id 定位（列表序号会随新增版本移位，用它验收会验收错对象）
// - 登记时保存源稿/新稿的 sha256 与原样快照；验收前核对当前文件内容，被调包的验收直接拒绝
// - 路径先 realpath 规范化再比较：`base.md` 与 `./base.md` 是同一个文件，字符串比较拦不住
// - 「保留」继承在服务端写事务内完成，按来源批注 id 幂等补齐；原文在新稿找不到的明确标记缺失

import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { offsetsOf, allocateNo } from './review.mjs';

const roundOf = (data, doc) => data.docRounds?.[doc] ?? data.activeRound ?? 0;

/* 旧数据没有 id：从 round|file|at 派生稳定 id——同一登记任何时候派生出的都是同一个值 */
export function versionIdOf(entry) {
  if (entry.id) return entry.id;
  return 'lg-' + createHash('sha1').update(`${entry.round}|${entry.file}|${entry.at}`).digest('hex').slice(0, 10);
}

export function listVersions(data, doc) {
  const all = data.versions?.[doc] || [];
  return all.map(item => ({ ...item, id: versionIdOf(item) })).reverse(); // 新版本在前
}

/* 登记前置：路径规范化、内容哈希、原样快照。docPath/filePath 必须是调用方 safeResolve 过的绝对路径。 */
export async function prepareVersionRegistration({ docPath, filePath, snapshotsDir }) {
  const [realDoc, realFile] = await Promise.all([
    realpath(docPath).catch(() => null),
    realpath(filePath).catch(() => null),
  ]);
  if (!realDoc) return { error: 'doc not found' };
  if (!realFile) return { error: 'version file not found' };
  if (realFile === realDoc) return { error: 'version file must differ from the original' };
  const [sourceRaw, nextRaw] = await Promise.all([readFile(realDoc), readFile(realFile)]);
  const sourceHash = createHash('sha256').update(sourceRaw).digest('hex');
  const nextHash = createHash('sha256').update(nextRaw).digest('hex');
  const id = `v-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  // 快照保存登记那一刻的两个文件原样：之后原件/新稿再怎么改，验收对照的基准都可恢复
  const ext = extname(realFile) || '.bin';
  const snapshot = {
    source: join(snapshotsDir, `${id}-source${ext}`),
    next: join(snapshotsDir, `${id}-next${ext}`),
  };
  try {
    await mkdir(snapshotsDir, { recursive: true });
    await Promise.all([copyFile(realDoc, snapshot.source), copyFile(realFile, snapshot.next)]);
  } catch (error) {
    // 快照写不出来 = 恢复路径缺失，登记不能假装成功
    return { error: `snapshot failed: ${error.message}` };
  }
  return {
    id, realDoc, realFile, sourceHash, nextHash,
    snapshot: { source: snapshot.source, next: snapshot.next }, // 绝对路径，调用方换算成 vault 相对路径入库
  };
}

export function registerVersion(data, { doc, file, note = '', id, sourceHash = '', nextHash = '', snapshot = null }) {
  if (!doc || !file) throw new Error('doc and file required');
  data.versions ||= {};
  data.versions[doc] ||= [];
  const round = roundOf(data, doc);
  const existing = data.versions[doc].find(v => v.file === file && v.round === round);
  if (existing) {
    // 同轮同文件再次登记：内容相同 = 幂等（已验收状态不得被重置回 pending）；内容不同 = 新版本，另立条目
    if (!nextHash || !existing.nextHash || existing.nextHash === nextHash) {
      if (note) existing.note = String(note).slice(0, 2000);
      return existing;
    }
  }
  const entry = {
    id: id || `v-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    round,
    file,
    note: String(note).slice(0, 2000),
    at: new Date().toISOString(),
    status: 'pending', // pending | accepted | rejected
    ...(sourceHash ? { sourceHash } : {}),
    ...(nextHash ? { nextHash } : {}),
    ...(snapshot ? { snapshot } : {}),
  };
  data.versions[doc].push(entry);
  return entry;
}

/* 验收按 id 定位。expectHash = 验收方刚从磁盘读到的内容哈希：
   与登记时不一致说明文件被改过，此时「已验收」会是谎言，必须拒绝。 */
export function setVersionStatus(data, doc, id, status, { expectHash = null } = {}) {
  const list = data.versions?.[doc] || [];
  const target = list.find(item => versionIdOf(item) === id);
  if (!target) throw Object.assign(new Error('version not found'), { code: 'version-not-found' });
  if (expectHash && target.nextHash && expectHash !== target.nextHash) {
    throw Object.assign(new Error('version-content-changed: decide against what you actually saw'), { code: 'version-content-changed' });
  }
  target.status = status;
  target.decidedAt = new Date().toISOString();
  return target;
}

/* 「保留的内容持续有效」：把源文档生效中的保留标记带到新版本文件。
   必须在 sidecar 写事务内调用。按来源批注 id 幂等——重复调用补齐缺口，绝不重复堆叠；
   逐条在新稿文本里核对原文是否还在，找不到的标记「缺失待确认」，不静默成功。 */
export function carryRetainedAnnotations(data, { fromDoc, toDoc, toText }) {
  const source = (data.docs[fromDoc] || []).filter(a => a.kind === 'highlight' && a.status === 'active');
  const target = data.docs[toDoc] || (data.docs[toDoc] = []);
  const carried = [], missing = [], skipped = [];
  const roundOfItem = item => (Number.isFinite(item.round) ? item.round : 0);
  for (const item of source) {
    if (target.some(a => a.carriedFrom === item.id)) { skipped.push(item.no || item.id); continue; }
    const offsets = offsetsOf(toText, item.quote, item.prefix);
    const lost = !offsets;
    const entry = {
      id: 'A-' + randomUUID(),
      version: 1,
      no: allocateNo(target, roundOfItem(item)),
      kind: 'highlight',
      round: roundOfItem(item),
      quote: item.quote,
      prefix: item.prefix || '',
      suffix: item.suffix || '',
      body: lost
        ? `【保留内容缺失，待确认】原文在新版中未找到。原要求：${item.body || '（未填写）'}`
        : (item.body || '（承自上一版的保留要求）'),
      x: Number.isFinite(item.x) ? item.x : 850,
      y: Number.isFinite(item.y) ? item.y : 0,
      region: null,
      image: null,
      created: new Date().toISOString(),
      status: 'active',
      weight: 1,
      history: [{ event: `carried_from_${item.id}`, at: new Date().toISOString(), ...(lost ? { note: '原文在新稿中未找到' } : {}) }],
      supersedes: [],
      conflicts_with: [],
      carriedFrom: item.id,
      carriedFromDoc: fromDoc,
      ...(lost ? { anchorStatus: 'missing' } : {}),
      ...(offsets ? { offsets } : {}),
    };
    target.push(entry);
    (lost ? missing : carried).push(entry.no);
  }
  return { carried, missing, skipped };
}

/* 段落级对照：保留顺序的 LCS——段落重排会如实显示为「删旧 + 增新」，
   而不是被多重集合比较抹成「毫无变化」。 */
const DIFF_LINE_LIMIT = 2000;

export function textDiff(originalText, nextText) {
  const split = (text) => String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  let before = split(originalText);
  let after = split(nextText);
  const truncated = before.length > DIFF_LINE_LIMIT || after.length > DIFF_LINE_LIMIT;
  if (truncated) {
    before = before.slice(0, DIFF_LINE_LIMIT);
    after = after.slice(0, DIFF_LINE_LIMIT);
  }
  const rows = [];
  const removed = [];
  const aligned = []; // 保留 LCS 输出顺序的完整序列：并排对照由它配对生成
  const n = before.length, m = after.length, w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = before[i] === after[j]
        ? lcs[(i + 1) * w + j + 1] + 1
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (before[i] === after[j]) { const row = { type: 'same', text: after[j] }; rows.push(row); aligned.push({ type: 'same', left: after[j], right: after[j] }); i += 1; j += 1; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) { removed.push(before[i]); aligned.push({ type: 'removed', left: before[i], right: null }); i += 1; }
    else { const row = { type: 'added', text: after[j] }; rows.push(row); aligned.push({ type: 'added', left: null, right: after[j] }); j += 1; }
  }
  while (i < n) { removed.push(before[i]); aligned.push({ type: 'removed', left: before[i], right: null }); i += 1; }
  while (j < m) { const row = { type: 'added', text: after[j] }; rows.push(row); aligned.push({ type: 'added', left: null, right: after[j] }); j += 1; }

  // 并排视图：相邻的「删旧块 × 增新块」按顺序配对成左右两列，一眼看清「这句换成了那句」
  const sideBySide = [];
  for (let k = 0; k < aligned.length;) {
    const item = aligned[k];
    if (item.type === 'removed') {
      const olds = [], news = [];
      while (k < aligned.length && aligned[k].type === 'removed') { olds.push(aligned[k].left); k += 1; }
      while (k < aligned.length && aligned[k].type === 'added') { news.push(aligned[k].right); k += 1; }
      for (let p = 0; p < Math.max(olds.length, news.length); p += 1) {
        sideBySide.push({ type: olds[p] !== undefined && news[p] !== undefined ? 'changed' : olds[p] !== undefined ? 'removed' : 'added', left: olds[p] ?? '', right: news[p] ?? '' });
      }
    } else if (item.type === 'added') {
      sideBySide.push({ type: 'added', left: '', right: item.right });
      k += 1;
    } else {
      sideBySide.push({ type: 'same', left: item.left, right: item.right });
      k += 1;
    }
  }
  return {
    rows,
    removed,
    sideBySide,
    orderAware: true,
    ...(truncated ? { truncated: true } : {}),
    summary: {
      added: rows.filter(row => row.type === 'added').length,
      removed: removed.length,
      unchanged: rows.filter(row => row.type === 'same').length,
    },
  };
}
