export const annotationVersion = item => Number(item.version) || 1;
export const currentRound = (data, doc) => data.docRounds?.[doc] ?? data.activeRound ?? 0;

/* 锚点偏移：quote 在文本中的位置（找不到时退 prefix 之后，再退 quote 前 12 字符）。
   ⚠ 这只是「定位建议」——prefix 兜底和前 12 字模糊命中绝不能当作「保留内容未改动」的
   证明；保留校验一律走 verifyRetainedText。server 的冲突检测与版本继承共用定位。 */
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

/* 保留内容校验（与定位分离）：
   - intact     完整 quote 精确出现一次（或重复但 prefix 能唯一消歧）
   - ambiguous  quote 多处出现且无法确定所指 → 待人工确认，不算通过
   - missing    完整原文不存在（prefix 残留/前 12 字相同都不算数）
   - unverified HTML 等标记文本：源字符串匹配不能证明正文未变，明确承认没校验
   只有 intact 才能被当作「保留成功」。 */
export function verifyRetainedText(text, quote, prefix, { isHtml = false } = {}) {
  if (isHtml) return { state: 'unverified', offsets: null };
  if (!quote) return { state: 'unverified', offsets: null, reason: 'no-quote' };
  const t = String(text || '');
  const first = t.indexOf(quote);
  if (first < 0) return { state: 'missing', offsets: null };
  const occurrences = t.split(quote).length - 1;
  if (occurrences > 1) {
    if (prefix) {
      const marked = t.indexOf(prefix + quote);
      if (marked >= 0 && t.indexOf(prefix + quote, marked + 1) < 0) {
        const start = marked + prefix.length;
        return { state: 'intact', offsets: { start, end: start + quote.length } };
      }
    }
    return { state: 'ambiguous', offsets: { start: first, end: first + quote.length } };
  }
  return { state: 'intact', offsets: { start: first, end: first + quote.length } };
}

/* 一份文档的保留健康汇总（供版本对照头部使用）。missing 明确单列，绝不并入 ok。 */
export function retainedHealth(data, doc, nextText, isHtml = false) {
  const list = (data.docs[doc] || []).filter(a => a.kind === 'highlight' && a.status === 'active');
  let ok = 0, missing = 0, unverified = 0;
  const missingNos = [];
  for (const item of list) {
    const verdict = verifyRetainedText(nextText, item.quote, item.prefix, { isHtml });
    if (verdict.state === 'intact') ok += 1;
    else if (verdict.state === 'missing') { missing += 1; missingNos.push(item.no || item.id); }
    else if (verdict.state === 'ambiguous') { ok += 0; missing += 0; unverified += 1; }
    else unverified += 1;
  }
  return { total: list.length, ok, missing, ambiguous: unverified, missingNos };
}

/* 最近一次 Agent 回应记录涉及的批注编号（退回边界与「回应了 N 条」汇总的依据）。
   批次推进会让 currentRound 失真，回应归属只能看事件记录，不能按 round 过滤。 */
export function lastResolvedNos(data, doc) {
  const history = data.roundHistory || [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry && entry.doc === doc && entry.reason === 'agent-resolved' && Array.isArray(entry.resolved)) {
      return entry.resolved.slice();
    }
  }
  return [];
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

/* U07 · 约束任务卡：一条批注 → 一句自包含指令（位置 + 引用 + 意见 + 动作）。
   MCP brief / 网页快照 / 指令落盘共用，Agent 不必再从零散字段拼装语义。
   page 已知时带页码；quote 过长截断保上下文。 */
export function buildInstruction(item, context) {
  const quote = (item.quote || "").trim();
  const ref = quote ? `「${quote.length > 60 ? quote.slice(0, 60) + "…" : quote}」` : "";
  const where = context && context.page ? `第 ${context.page} 页` : (context && context.where) || "文中";
  const opinion = (item.body || "").trim();
  switch (item.kind) {
    case "highlight":
      return `${where}的 ${item.no || ""}保留要求：${ref} 这段内容用户要求原样保留——不删除、不改写、不移动${opinion ? `；用户说明：${opinion}` : ""}。`;
    case "strike":
      return `${where}的 ${item.no || ""}删除要求：${ref} 这段被用户划了删除线——删除或按新表述重写${opinion ? `；用户意见：${opinion}` : ""}。`;
    case "region":
      return `${where}的 ${item.no || ""}区域批注：用户框选了文档中的一块区域（比例位置 x=${item.region?.x?.toFixed(2)}, y=${item.region?.y?.toFixed(2)}），意见：${opinion || "（未填写，请结合页面内容理解）"}。`;
    default:
      return `${where}的 ${item.no || ""}修改意见：针对 ${ref || "该处内容"}，用户要求：${opinion || "（未填写具体意见，请阅读上下文判断合理修改）"}。`;
  }
}

export function reviewSnapshot(data, doc) {
  const list = data.docs[doc] || [];
  const expose = item => ({ ...item, version: annotationVersion(item), instruction: buildInstruction(item, { page: item.region?.page, where: item.region ? "文档区域" : "文中" }), requirement: item.kind === 'highlight' ? '保留原文，不删除、不改写；仅用户取消后解除。' : item.body });
  const pending = list.filter(a => a.status === 'active' && a.kind !== 'highlight').map(expose);
  const retained = list.filter(a => a.status === 'active' && a.kind === 'highlight').map(expose);
  const attention = list.filter(a => a.status === 'stale' || a.anchorStatus === 'missing').map(expose);
  const history = list.filter(a => !['active', 'stale'].includes(a.status)).map(expose);
  return {
    doc, revision: data.revision || 0, round: currentRound(data, doc),
    pending, retained, attention, history,
    // 持久可发现：覆盖范围与总数明示——Agent 必须能确认"读到的是全部"，而不是静默截断
    coverage: {
      totalAnnotations: list.length,
      pendingCount: pending.length,
      retainedCount: retained.length,
      attentionCount: attention.length,
      complete: true,
      note: "以上为该文档全部未完成意见与有效保留要求（无分页截断）；默认最小改动原则：未提及的内容保持原样。",
    },
    defaultPolicy: "最小改动原则：除上述意见与保留要求外，文档其余内容保持原样——不擅自润色、改数字、删引用、换结构；跨段一致性调整需先说明。",
  };
}

/* 用户退回版本：只重开「本次回应记录」里的批注（nos = lastResolvedNos）。
   Agent 的 resolve 是它的声明；人退回这个版本，就是否决了这份声明——被否决的
   那批问题回到待办。没有回应记录就退回 = 只改版本状态，不翻任何历史批注。
   批次计数单调前进，不随审阅操作回滚。保留（highlight）不受退回影响。 */
export function reopenResolvedAnnotations(data, doc, nos = []) {
  const list = data.docs[doc] || [];
  const at = new Date().toISOString();
  const targets = new Set((nos || []).map(String));
  if (!targets.size) return [];
  const reopened = [];
  for (const item of list) {
    if (item.kind === 'highlight' || item.status !== 'addressed') continue;
    const identity = String(item.no || '');
    const internal = String(item.id || '');
    if (!targets.has(identity) && !targets.has(internal)) continue;
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
