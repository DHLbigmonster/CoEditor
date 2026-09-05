// 版本对照：Agent 改完文档后登记新版本，人在这里验收 / 退回，并可继续在新版本上批注。
// 原则与全文一致：原件永不被覆盖，新版本是旁边的新文件。

const roundOf = (data, doc) => data.docRounds?.[doc] ?? data.activeRound ?? 0;

export function listVersions(data, doc) {
  const all = data.versions?.[doc] || [];
  return all.map((item, index) => ({ ...item, index })).reverse(); // 新版本在前
}

export function registerVersion(data, { doc, file, note = '' }, { requireFile = true } = {}) {
  if (!doc || !file) throw new Error('doc and file required');
  if (requireFile && String(file) === String(doc)) throw new Error('version file must differ from the original');
  data.versions ||= {};
  data.versions[doc] ||= [];
  const round = roundOf(data, doc);
  const entry = {
    round,
    file,
    note: String(note).slice(0, 2000),
    at: new Date().toISOString(),
    status: 'pending', // pending | accepted | rejected
  };
  // 同一轮同一文件重复登记视为更新，而不是堆两条
  const existing = data.versions[doc].findIndex(v => v.file === file && v.round === round);
  if (existing >= 0) data.versions[doc][existing] = { ...data.versions[doc][existing], ...entry };
  else data.versions[doc].push(entry);
  return entry;
}

export function setVersionStatus(data, doc, index, status) {
  const list = data.versions?.[doc] || [];
  const at = new Date().toISOString();
  // index 以「新版本在前」的展示顺序为准，这里换算回存储顺序
  const reversed = [...list].reverse();
  const target = reversed[index];
  if (!target) throw new Error('version not found');
  target.status = status;
  target.decidedAt = at;
  return target;
}

/* 段落级对照：不追求逐字 diff，只回答「这一轮改了哪里」——新增 / 删除 / 保留。 */
export function textDiff(originalText, nextText) {
  const split = (text) => String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const before = split(originalText);
  const after = split(nextText);
  const counts = new Map();
  for (const line of before) counts.set(line, (counts.get(line) || 0) + 1);
  const rows = [];
  for (const line of after) {
    const left = counts.get(line) || 0;
    if (left > 0) { counts.set(line, left - 1); rows.push({ type: 'same', text: line }); }
    else rows.push({ type: 'added', text: line });
  }
  const remaining = [];
  for (const [line, count] of counts) for (let i = 0; i < count; i += 1) remaining.push(line);
  return {
    rows,
    removed: remaining,
    summary: {
      added: rows.filter(row => row.type === 'added').length,
      removed: remaining.length,
      same: rows.filter(row => row.type === 'same').length,
    },
  };
}
