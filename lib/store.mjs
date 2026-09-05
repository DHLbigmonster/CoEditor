import { readFile, writeFile, mkdir, open, rename, unlink, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

const keys = ['arrows', 'notes', 'images', 'drafts'];
export async function readStore(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    if (!data || typeof data.docs !== 'object' || Array.isArray(data.docs) || !data.docs ||
        Object.values(data.docs).some(list => !Array.isArray(list))) throw new Error('invalid sidecar schema');
    for (const key of keys) {
      if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`invalid ${key}`);
      data[key] ||= [];
    }
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, revision: 0, docs: {}, arrows: [], notes: [], images: [], drafts: [] };
    throw new Error(`sidecar-unreadable: ${error.message}`);
  }
}

// Both HTTP and MCP must hold this lock for the WHOLE read/modify/write transaction.
// A unique temporary filename alone does not prevent lost updates.
//
// 锁用「独占创建单个文件」而不是目录：
// 目录锁的释放是 unlink + rmdir 两步，并发下另一方可在两步之间抢到锁、随后被前一方的 rmdir 抹掉，
// 于是同时出现多个持有者（表现为 EEXIST 外泄 / 批注丢失）。单文件锁的获取与释放都是原子操作。
const LOCK_TIMEOUT_MS = 15000;   // 拿不到锁的等待上限：如实报 busy，绝不抢别人的锁
const LOCK_HEARTBEAT_MS = 10000; // 持有者心跳：长事务期间持续刷新锁文件的 at
const LOCK_STALE_MS = 120000;    // 心跳停跳 2 分钟 = 持有者僵死（事件循环卡死），才允许回收

async function removeStaleLock(lockFile) {
  try {
    const info = JSON.parse(await readFile(lockFile, 'utf8'));
    let alive = true;
    try { process.kill(info.pid, 0); } catch (error) { alive = error.code !== 'ESRCH'; } // EPERM=进程存在（他人的）；ESRCH=确实不在了
    // 活着的持有者绝不因超时被抢——半截事务被打断就是丢数据。宁可如实报 busy。
    if (alive && Date.now() - (info.at || 0) < LOCK_STALE_MS) return false;
    await unlink(lockFile).catch(() => {});
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return true; // 锁已消失，直接重试
    return false; // 读不出来的锁一律不碰（fail closed）
  }
}

export async function acquireStoreLock(file) {
  await mkdir(dirname(file), { recursive: true });
  const lockFile = `${file}.lock`;
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    let handle = null;
    try {
      handle = await open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, at: Date.now() }), 'utf8');
      await handle.close(); handle = null;
      break;
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== 'EEXIST') throw error;
      if (!await removeStaleLock(lockFile) && Date.now() - started > LOCK_TIMEOUT_MS) {
        throw new Error('store-busy: another writer is active, retry shortly');
      }
      await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 35));
    }
  }
  // 长事务心跳：大 vault 全量重写、慢盘上的 RMW 可能远超 30 秒，心跳让它们不被误判僵死
  const heartbeat = setInterval(() => {
    writeFile(lockFile, JSON.stringify({ pid: process.pid, token, at: Date.now() }), 'utf8').catch(() => {});
  }, LOCK_HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();
  return async () => {
    clearInterval(heartbeat);
    try {
      const info = JSON.parse(await readFile(lockFile, 'utf8'));
      if (info.token !== token) return false; // 锁已被接管：不能删别人的锁，如实放弃
      await unlink(lockFile);
    } catch (error) {
      if (error.code !== 'ENOENT') return false; // 释放失败不外抛：锁最迟随心跳过期被回收
    }
    return true;
  };
}

/* 推荐入口：整个 RMW 事务都在锁内。HTTP 与 MCP 的写都应该走它，而不是各自 readStore/writeStore。 */
export async function withStoreTransaction(file, mutate, opts = {}) {
  const unlock = await acquireStoreLock(file);
  try {
    const data = await readStore(file);
    const next = await mutate(data);
    if (next !== undefined) await writeStore(file, next, opts);
    return next === undefined ? data : next;
  } finally {
    await unlock();
  }
}

export async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tmp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close(); handle = null;
    await rename(tmp, file);
  } finally {
    if (handle) await handle.close();
    await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function writeStore(file, data, opts = {}) {
  const current = await readStore(file);
  if ((data.revision || 0) !== (current.revision || 0)) throw new Error('store-conflict: reload before writing');
  const count = d => Object.values(d.docs).reduce((n, list) => n + list.length, 0);
  if (count(current) > count(data) + (opts.allowedRemovals || 0)) throw new Error('blocked-destructive-annotation-loss');
  for (const key of keys) {
    data[key] ||= [];
    if (current[key].length > data[key].length + (opts.allowedCanvasRemovals?.[key] || 0)) throw new Error(`blocked-destructive-canvas-loss: ${key}`);
  }
  // Backup failure must prevent the write, rather than silently removing the recovery path.
  if (await stat(file).catch(e => { if (e.code === 'ENOENT') return null; throw e; })) {
    await atomicWrite(`${file}.prev`, await readFile(file, 'utf8'));
  }
  data.revision = (current.revision || 0) + 1;
  data.updatedAt = new Date().toISOString();
  await atomicWrite(file, JSON.stringify(data, null, 2));
}
