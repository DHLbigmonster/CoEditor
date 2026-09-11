/* ============================================================================
 * 最小 ZIP 读取器（零依赖）
 *
 * 为什么自己写：
 *  1. PPTX 本质就是 zip。要「打开就能看」就不能依赖用户装 unzip（Windows 没有），
 *     也不能为此引入 jszip/adm-zip 这类第三方依赖（项目红线：零重依赖）。
 *  2. 只需要读，不需要写 —— 所以只要能定位中央目录 + inflate 就够了。
 *
 * 只做读；写回 PPTX 是另一条链路（且不在本次范围）。
 * ========================================================================== */
import { inflateRawSync } from "node:zlib";
import { readFile } from "node:fs/promises";

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

export async function openZip(absPath) {
  return parseZip(await readFile(absPath));
}

export function parseZip(buf) {
  /* 从尾部往前找 EOCD（注释最长 65535，所以最多回扫 66KB） */
  let eocd = -1;
  const floor = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= floor; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 zip/pptx：找不到结尾记录（文件可能损坏）");

  let total = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  /* zip64：大文件（>4GB 或 >65535 条目）用另一套记录 */
  if (cdOffset === 0xffffffff || total === 0xffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === SIG_LOC64) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (z64 >= 0 && z64 + 56 <= buf.length && buf.readUInt32LE(z64) === SIG_EOCD64) {
        total = Number(buf.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < total; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    const extraStart = p + 46 + nameLen;
    const extraEnd = Math.min(extraStart + extraLen, buf.length);
    let q = extraStart;
    while (q + 4 <= extraEnd) {
      const headId = buf.readUInt16LE(q);
      const headSize = buf.readUInt16LE(q + 2);
      if (headId === 0x0001) {
        let r = q + 4;
        if (size === 0xffffffff && r + 8 <= q + headSize) { size = Number(buf.readBigUInt64LE(r)); r += 8; }
        if (compSize === 0xffffffff && r + 8 <= q + headSize) { compSize = Number(buf.readBigUInt64LE(r)); r += 8; }
        if (localOff === 0xffffffff && r + 8 <= q + headSize) { localOff = Number(buf.readBigUInt64LE(r)); }
        break;
      }
      q += 4 + headSize;
    }

    entries.set(name, { name, method, flags, compSize, size, localOff });
    p += 46 + nameLen + extraLen + commentLen;
  }

  function extract(entry) {
    const q = entry.localOff;
    if (q + 30 > buf.length || buf.readUInt32LE(q) !== SIG_LOC) {
      throw new Error(`压缩包条目损坏：${entry.name}`);
    }
    if (entry.flags & 0x1) throw new Error(`这份 PPTX 被加密/加了密码，无法读取：${entry.name}`);
    const nameLen = buf.readUInt16LE(q + 26);
    const extraLen = buf.readUInt16LE(q + 28);
    const start = q + 30 + nameLen + extraLen;
    const end = Math.min(start + entry.compSize, buf.length);
    const raw = buf.subarray(start, end);
    if (entry.method === 0) return Buffer.from(raw);
    if (entry.method === 8) return inflateRawSync(raw);
    throw new Error(`不支持的压缩方式（${entry.method}）：${entry.name}`);
  }

  return {
    size: buf.length,
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    buffer(name) { return extract(entries.get(name)); },
    text(name) { return extract(entries.get(name)).toString("utf8"); },
  };
}
