export const annotationVersion = item => Number(item.version) || 1;
export const currentRound = (data, doc) => data.docRounds?.[doc] ?? data.activeRound ?? 0;

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
