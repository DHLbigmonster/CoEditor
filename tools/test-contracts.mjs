// 产品契约回归（源自 2026-09-06 审查探针，转为正式用例）：
// F01 保留校验不得假成功 · F04 回应计数/退回边界 · F09 快照身份 · F10 空白语义 diff
// 纯函数级：无 HTTP、无用户文件。每个用例对应报告里的一个反例。
import test from 'node:test';
import assert from 'node:assert/strict';
import { offsetsOf, resolveReviewed, reopenResolvedAnnotations, currentRound, verifyRetainedText, retainedHealth, lastResolvedNos } from '../lib/review.mjs';
import { carryRetainedAnnotations, textDiff, registerVersion } from '../lib/version.mjs';

const DOC = 'synthetic.md';
const QUOTE = 'Never change this exact approved sentence.';
const PREFIX = 'Heading: ';

test('F01a: 整段保留原文被删、只剩 prefix 时，绝不能报 carried 成功', () => {
  const rewritten = PREFIX + 'completely rewritten and deleted the approved passage.';
  const verdict = verifyRetainedText(rewritten, QUOTE, PREFIX);
  assert.equal(verdict.state, 'missing');
  const data = { docs: { [DOC]: [{ id: 'r1', no: '0-1', round: 0, kind: 'highlight', status: 'active', quote: QUOTE, prefix: PREFIX, body: 'Keep verbatim.' }] } };
  const carried = carryRetainedAnnotations(data, { fromDoc: DOC, toDoc: 'next.md', toText: rewritten });
  assert.deepEqual(carried.missing, ['0-1']);
  assert.deepEqual(carried.carried, []);
  assert.equal(data.docs['next.md'][0].anchorStatus, 'missing');
});

test('F01b: 只有 quote 前 12 个字符相同也不算 intact', () => {
  const partial = PREFIX + QUOTE.slice(0, 12) + ' and then something entirely different follows here.';
  assert.equal(verifyRetainedText(partial, QUOTE, PREFIX).state, 'missing');
});

test('F01c: 完整 quote 精确出现一次才算 intact，且给出精确区间', () => {
  const ok = PREFIX + QUOTE + '\n\nMore text.';
  const verdict = verifyRetainedText(ok, QUOTE, PREFIX);
  assert.equal(verdict.state, 'intact');
  assert.equal(ok.slice(verdict.offsets.start, verdict.offsets.end), QUOTE);
  // 模糊定位（offsetsOf）仍是定位建议，不承担校验语义
  assert.ok(offsetsOf(ok, QUOTE, PREFIX));
});

test('F01d: quote 重复出现且 prefix 无法消歧时标 ambiguous，不得谎称 intact', () => {
  const dup = QUOTE + '\n\nagain: ' + QUOTE;
  const verdict = verifyRetainedText(dup, QUOTE, '');
  assert.equal(verdict.state, 'ambiguous');
  // prefix 能消歧时可以 intact
  const disambiguated = 'Header: ' + QUOTE + '\n\nagain: ' + QUOTE;
  assert.equal(verifyRetainedText(disambiguated, QUOTE, 'Header: ').state, 'intact');
});

test('F01e: HTML 源文本不能当正文校验——明确 unverified，不假装核验过', () => {
  const verdict = verifyRetainedText('<p>Never change this exact approved sentence.</p>', QUOTE, '', { isHtml: true });
  assert.equal(verdict.state, 'unverified');
});

test('F01f: retainedHealth 汇总——删除保留原文计 missing，不得计入 ok', () => {
  const data = { docs: { [DOC]: [
    { id: 'r1', no: '0-1', kind: 'highlight', status: 'active', quote: QUOTE, prefix: PREFIX },
    { id: 'r2', no: '0-2', kind: 'highlight', status: 'active', quote: 'still here fine', prefix: '' },
  ] } };
  const nextText = PREFIX + 'rewritten...\n\nstill here fine';
  const health = retainedHealth(data, DOC, nextText, false);
  assert.equal(health.total, 2);
  assert.equal(health.ok, 1);
  assert.equal(health.missing, 1);
});

test('F04a: resolve 后回应计数按本次 resolve 记录取，不按 currentRound 过滤成 0', () => {
  const data = { docs: { [DOC]: [{ id: 't1', no: '0-1', round: 0, kind: 'text', status: 'active', version: 1 }] }, docRounds: { [DOC]: 0 } };
  const result = resolveReviewed(data, { doc: DOC, ids: ['0-1'], versions: { '0-1': 1 } });
  assert.deepEqual(result.resolved, ['0-1']);
  assert.equal(currentRound(data, DOC), 1);
  const nos = lastResolvedNos(data, DOC);
  assert.deepEqual(nos, ['0-1']);
});

test('F04b: 退回只重开本次回应记录里的批注，无关历史保持 addressed，批次不回退', () => {
  const data = {
    docs: { [DOC]: [
      { id: 'old', no: '0-1', round: 0, kind: 'text', status: 'addressed', version: 2 },
      { id: 'cur', no: '1-1', round: 1, kind: 'text', status: 'addressed', version: 2 },
    ] },
    docRounds: { [DOC]: 2 },
    roundHistory: [{ doc: DOC, round: 1, reason: 'agent-resolved', resolved: ['1-1'] }],
  };
  const reopened = reopenResolvedAnnotations(data, DOC, lastResolvedNos(data, DOC));
  assert.deepEqual(reopened, ['1-1']);
  assert.equal(data.docs[DOC][0].status, 'addressed');
  assert.equal(data.docs[DOC][1].status, 'active');
  assert.equal(data.docRounds[DOC], 2); // 批次单调前进，不回滚
});

test('F04c: 没有回应记录时不重开任何批注（退回只是版本状态）', () => {
  const data = {
    docs: { [DOC]: [{ id: 'x', no: '0-1', round: 0, kind: 'text', status: 'addressed', version: 2 }] },
    docRounds: { [DOC]: 1 },
    roundHistory: [],
  };
  assert.deepEqual(reopenResolvedAnnotations(data, DOC, lastResolvedNos(data, DOC)), []);
  assert.equal(data.docs[DOC][0].status, 'addressed');
});

test('F10: 缩进/空白语义保留——嵌套列表改平级必须显示为变化', () => {
  const diff = textDiff('- parent\n    - child', '- parent\n- child');
  assert.ok(diff.summary.added > 0 || diff.summary.removed > 0, '空白变化不得被 trim 抹平');
});

test('F09: 登记幂等把 sourceHash 纳入身份——原稿变化后同 file 另立新条目', () => {
  const data = { versions: {}, docRounds: { [DOC]: 0 } };
  const first = registerVersion(data, { doc: DOC, file: 'synthetic-v2.md', id: 'v-a', sourceHash: 'aaa', nextHash: 'nnn' });
  const idempotent = registerVersion(data, { doc: DOC, file: 'synthetic-v2.md', id: 'v-b', sourceHash: 'aaa', nextHash: 'nnn' });
  assert.equal(idempotent.id, first.id); // 同稿同源 → 幂等
  const drifted = registerVersion(data, { doc: DOC, file: 'synthetic-v2.md', id: 'v-c', sourceHash: 'changed', nextHash: 'nnn' });
  assert.notEqual(drifted.id, first.id); // 原稿变了 → 新条目
  assert.equal(data.versions[DOC].length, 2);
});
