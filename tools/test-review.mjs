import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { readStore, writeStore, acquireStoreLock } from '../lib/store.mjs';

const repo = new URL('../', import.meta.url).pathname;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'coeditor-review-test-'));
  await writeFile(join(root, 'review.md'), '# Review\n\nKeep this sentence. Improve this paragraph.\n');
  const child = spawn(process.execPath, [join(repo, 'server.mjs'), root], { env: { ...process.env, COEDITOR_PORT: '0', COEDITOR_STATE_DIR: join(root, '.state') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server timeout: ' + output)), 8000);
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+/); if (match) { clearTimeout(timer); resolve(match[0]); } });
    child.on('error', reject);
  });
  t.after(async () => { child.kill(); await once(child, 'close'); await rm(root, { recursive: true, force: true }); });
  const api = async (path, body, method = 'POST', headers = {}) => {
    const res = await fetch(base + path, body === undefined ? {} : { method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const add = async (kind = 'text', body = 'Improve the evidence.') => (await api('/api/annotations?p=review.md', { kind, body, quote: kind === 'highlight' ? 'Keep this sentence.' : 'Improve this paragraph.' })).data.annotation;
  const mcp = async (name, args) => {
    const proc = spawn(process.execPath, [join(repo, 'mcp-stdio.mjs'), root], { stdio: ['pipe', 'pipe', 'inherit'] });
    let out = ''; proc.stdout.on('data', c => { out += c; });
    proc.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    await once(proc, 'close');
    const response = JSON.parse(out.trim()).result;
    if (response.error) throw new Error(response.error.message);
    return JSON.parse(response.content[0].text);
  };
  return { root, base, api, add, mcp, store: join(root, '.marginalia', 'annotations.json') };
}

test('20 concurrent HTTP writes preserve all annotations and unique numbers', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => f.add('text', 'request ' + i)));
  assert.equal(results.filter(Boolean).length, 20);
  const data = await readStore(f.store);
  assert.equal(data.docs['review.md'].length, 20);
  assert.equal(new Set(results.map(a => a.no)).size, 20);
  assert.equal(new Set(results.map(a => a.id)).size, 20);
  assert.ok(data.revision >= 20);
  assert.ok(JSON.parse(await readFile(f.store + '.prev', 'utf8')).docs);
});

test('MCP resolve and HTTP edits share a transaction; retained text never auto-resolves', async t => {
  const f = await fixture(t), kept = await f.add('highlight'), task = await f.add();
  const [result] = await Promise.all([
    f.mcp('resolve_annotations', { doc: 'review.md', ids: [kept.no, task.no], versions: { [kept.no]: 1, [task.no]: 1 }, note: 'Added evidence' }),
    ...Array.from({ length: 12 }, (_, i) => f.add('text', 'new request ' + i)),
  ]);
  assert.deepEqual(result.resolved, [task.no]);
  assert.equal(result.skipped[0].reason, 'retained-until-user-cancels');
  const snapshot = await f.mcp('get_review', { doc: 'review.md' });
  assert.equal(snapshot.retained.length, 1); assert.equal(snapshot.pending.length, 12);
  assert.equal(snapshot.history.length, 1);
});

test('a newer human edit prevents stale Agent completion', async t => {
  const f = await fixture(t), item = await f.add();
  await f.api('/api/annotations?p=review.md', { id: item.id, body: 'Also add a source', version: 1 }, 'PATCH');
  const stale = await f.mcp('resolve_annotations', { doc: 'review.md', ids: [item.no], versions: { [item.no]: 1 } });
  assert.equal(stale.resolved.length, 0); assert.match(stale.skipped[0].reason, /version-mismatch/);
  const fresh = await f.mcp('get_review', { doc: 'review.md' });
  assert.equal(fresh.pending[0].version, 2);
});

test('completion opens next round only for that document; retention remains active', async t => {
  const f = await fixture(t), keep = await f.add('highlight'), item = await f.add();
  const resolved = await f.api('/api/resolve?p=review.md', { ids: [item.no], versions: { [item.no]: 1 } });
  assert.equal(resolved.data.activeRound, 1);
  const next = await f.add(); assert.equal(next.no, '1-1');
  const other = await f.api('/api/annotations?p=other.md', { body: 'other document', quote: 'sample' });
  assert.equal(other.data.annotation.no, '0-1');
  assert.equal((await readStore(f.store)).docs['review.md'].find(a => a.id === keep.id).status, 'active');
});

test('numbers are not reused after deleting the last item', async t => {
  const f = await fixture(t), item = await f.add();
  await f.api('/api/annotations?p=review.md', { id: item.id }, 'DELETE');
  const next = await f.add(); assert.equal(next.no, '0-2'); assert.notEqual(next.id, item.id);
});

test('external document change rejects repeated stale saves and preserves original backup', async t => {
  const f = await fixture(t), doc = (await f.api('/api/doc?p=review.md')).data;
  await writeFile(join(f.root, 'review.md'), '# External version');
  for (let i = 0; i < 2; i++) assert.equal((await f.api('/api/write?p=review.md', { text: 'stale draft', baseMtime: doc.mtime })).status, 409);
  assert.equal(await readFile(join(f.root, 'review.md'), 'utf8'), '# External version');
  const fresh = (await f.api('/api/doc?p=review.md')).data;
  assert.equal((await f.api('/api/write?p=review.md', { text: '# Saved safely', baseMtime: fresh.mtime })).status, 200);
});

test('corrupt sidecar fails closed in HTTP and MCP', async t => {
  const f = await fixture(t); await mkdir(join(f.root, '.marginalia'), { recursive: true });
  await writeFile(f.store, '{broken');
  assert.equal((await f.api('/api/annotations?p=review.md', { body: 'never replace corruption' })).status, 500);
  await assert.rejects(f.mcp('get_review', { doc: 'review.md' }), /sidecar-unreadable/);
  assert.equal(await readFile(f.store, 'utf8'), '{broken');
});

test('store rejects same-count stale updates; malformed JSON cannot crash server', async t => {
  const f = await fixture(t); await f.add();
  const a = await readStore(f.store), b = await readStore(f.store);
  const unlock = await acquireStoreLock(f.store);
  try { a.docs['review.md'][0].body = 'fresh'; await writeStore(f.store, a); await assert.rejects(writeStore(f.store, b), /store-conflict/); } finally { await unlock(); }
  const bad = await fetch(f.base + '/api/create-file', { method: 'POST', body: '{bad' });
  assert.equal(bad.status, 500); assert.equal((await f.api('/api/tree')).status, 200);
});

test('new file refuses overwrite and cross-origin writes are blocked', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/create-file', { name: 'review', ext: '.md' })).status, 409);
  assert.equal((await f.api('/api/create-file', { name: 'malicious', ext: '.md' }, 'POST', { origin: 'https://unrelated.example' })).status, 403);
  assert.equal((await f.api('/api/create-file', { name: 'good', ext: '.txt' })).status, 200);
});
