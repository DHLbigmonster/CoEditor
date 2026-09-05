export const annotationVersion = item => Number(item.version) || 1;
export const currentRound = (data, doc) => data.docRounds?.[doc] ?? data.activeRound ?? 0;

/* 锚点偏移：quote 在文本中的位置（找不到时退 prefix 之后，再退 quote 前 12 字符）。
   server 的冲突检测与版本的保留继承共用这一份逻辑，避免两处判定漂移。 */
export function offsetsOf(text, quote, prefix) {
  if (!quote) return null;
  let at = String(text || '').indexOf(quote);
  if (at < 0 && prefix) {
    const p = String(text || '').indexOf(prefix);
    if (p >= 0) at = p + prefix.length;
  }
  if (at < 0 && quote.length > 12) at = String(text || '').indexOf(quote.slice(0, 12));
  return at < 0 ? null : { start: at, end: at + quote.length };
}

/* 批注显示号：no = "批次-序号"（0-1、0-2……）。读时懒迁移固化，删除不复用。 */
export function ensureAnnotationNos(data) {
  let changed = false;
  for (const list of Object.values(data.docs || {})) {
    const usedByRound = new Map();
    for (const item of list) {
      const round = Number.isFinite(item.round) ? item.round : 0;
      if (!usedByRound.has(round)) usedByRound.set(round, new Set());
      const match = typeof item.no === "string" ? /^(\d+)-(\d+)$/.exec(item.no) : null;
      if (match && Number(match[1]) === round && Number(match[2]) > 0) usedByRound.get(round).add(Number(match[2]));
    }
    for (const item of list) {
      const round = Number.isFinite(item.round) ? item.round : 0;
      const match = typeof item.no === "string" ? /^(\d+)-(\d+)$/.exec(item.no) : null;
      if (!match || Number(match[1]) !== round || Number(match[2]) <= 0) {
        const used = usedByRound.get(round);
        let seq = 1;
        while (used.has(seq)) seq += 1;
        used.add(seq);
        item.no = `${round}-${seq}`;
        changed = true;
      }
    }
  }
  return changed;
}

export function allocateNo(list, round) {
  ensureAnnotationNos({ docs: { current: list } });
  const max = list.reduce((value, item) => {
    const match = typeof item.no === "string" ? /^(\d+)-(\d+)$/.exec(item.no) : null;
    return match && Number(match[1]) === round ? Math.max(value, Number(match[2])) : value;
  }, 0);
  return `${round}-${max + 1}`;
}

export function reviewSnapshot(data, doc) {
  const list = data.docs[doc] || [];
  const expose = item => ({ ...item, version: annotationVersion(item), requirement: item.kind === 'highlight' ? '保留原文，不删除、不改写；仅用户取消后解除。' : item.body });
  return {
    doc, revision: data.revision || 0, round: currentRound(data, doc),
    pending: list.filter(a => a.status === 'active' && a.kind !== 'highlight').map(expose),
    retained: list.filter(a => a.status === 'active' && a.kind === 'highlight').map(expose),
    attention: list.filter(a => a.status === 'stale' || a.anchorStatus === 'missing').map(expose),
    history: list.filter(a => !['active', 'stale'].includes(a.status)).map(expose),
  };
}

/* 用户退回版本：被 Agent 标记「已处理」的批注重回待处理。
   Agent 的 resolve 是它的声明；人退回这个版本，就是否决了这份声明——
   相关问题必须重新回到待办，而不是留在已归档里假装完成了。
   不按批注轮次过滤：Agent 一轮里可能回应更早轮次的遗留批注。
   保留标记不受退回影响。 */
export function reopenResolvedAnnotations(data, doc) {
  const list = data.docs[doc] || [];
  const at = new Date().toISOString();
  const reopened = [];
  for (const item of list) {
    if (item.kind === 'highlight' || item.status !== 'addressed') continue;
    item.status = 'active';
    item.weight = 1;
    item.version = annotationVersion(item) + 1;
    item.history ||= [];
    item.history.push({ event: 'user-rejected-reopened', at });
    reopened.push(item.no || item.id);
  }
  return reopened;
}

export function resolveReviewed(data, { doc, ids = [], versions = {}, note = '' }) {
  if (!Array.isArray(ids) || !doc) throw new Error('doc and ids required');
  const list = data.docs[doc] || [];
  const resolved = [], skipped = [];
  const at = new Date().toISOString();
  for (const id of [...new Set(ids)]) {
    const item = list.find(a => a.id === id || a.no === id);
    let reason;
    if (!item) reason = 'not-found';
    else if (item.kind === 'highlight') reason = 'retained-until-user-cancels';
    else if (item.status !== 'active') reason = 'not-pending';
    else if (versions[id] !== annotationVersion(item)) reason = 'version-mismatch: read again before resolving';
    if (reason) { skipped.push({ id, reason }); continue; }
    item.status = 'addressed';
    item.weight = 0.5;
    item.version = annotationVersion(item) + 1;
    item.history ||= [];
    item.history.push({ event: 'agent-resolved', at, note: String(note).slice(0, 2000) });
    resolved.push(item.no || item.id);
  }
  // A completed review, not an arbitrary file mtime change, opens the next document round.
  const round = currentRound(data, doc);
  if (resolved.length && !list.some(a => a.status === 'active' && a.kind !== 'highlight')) {
    data.docRounds ||= {};
    data.docRounds[doc] = round + 1;
    data.roundHistory ||= [];
    data.roundHistory.push({ doc, round, closedAt: at, reason: 'agent-resolved', resolved });
  }
  return { ok: true, resolved, skipped, activeRound: currentRound(data, doc) };
}
