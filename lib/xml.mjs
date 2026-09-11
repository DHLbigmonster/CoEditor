/* ============================================================================
 * 容忍型 XML 解析器（零依赖，只够 OOXML 用）
 *
 * 保留命名空间前缀（p:sp / a:t），因为 OOXML 的语义就长在名字上，
 * 拆掉前缀反而更难读、更容易写错。
 *
 * 容忍是刻意的：PowerPoint 及各路生成器产出的 XML 里，注释、CDATA、
 * 自定义命名空间、孤立实体都可能出现。宁可跳过看不懂的，也不要整份解析失败
 * —— 那会直接导致「这份 PPT 打不开」，是我们要避免的最坏结果。
 * ========================================================================== */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text) {
  if (!text.includes("&")) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (full, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : full;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : full;
  });
}

/** 找标签结束的 '>'，跳过属性值里的 '>' */
function tagEnd(src, from) {
  let quote = null;
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === ">") return i;
  }
  return -1;
}

const ATTR_RE = /([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttrs(src) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? "");
  return attrs;
}

export function parseXml(input) {
  const src = String(input || "");
  const root = { tag: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;

  const addText = (value) => {
    if (!value) return;
    const node = stack[stack.length - 1];
    node.children.push({ tag: "#text", attrs: {}, children: [], text: decodeEntities(value) });
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) { addText(src.slice(i)); break; }
    if (lt > i) { addText(src.slice(i, lt)); i = lt; }

    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i);
      addText(src.slice(i + 9, end < 0 ? src.length : end));
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      if (end < 0) break;
      i = end + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }

    const end = tagEnd(src, i);
    if (end < 0) break;
    const body = src.slice(i + 1, end);
    i = end + 1;

    if (!body.trim()) continue;
    const selfClose = body.endsWith("/");
    const clean = selfClose ? body.slice(0, -1) : body;
    const spaceAt = clean.search(/[\s]/);
    const tag = spaceAt < 0 ? clean : clean.slice(0, spaceAt);
    if (!tag) continue;
    const node = { tag, attrs: spaceAt < 0 ? {} : parseAttrs(clean.slice(spaceAt)), children: [], text: "" };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }

  return root;
}

/* ------------------------------- 取值小工具 ------------------------------- */

export const child = (node, tag) => {
  if (!node) return null;
  for (const c of node.children) if (c.tag === tag) return c;
  return null;
};

export const children = (node, tag) => (node ? node.children.filter((c) => c.tag === tag) : []);

export const attr = (node, name, fallback = null) => {
  const v = node?.attrs?.[name];
  return v === undefined || v === "" ? fallback : v;
};

export const num = (node, name, fallback = 0) => {
  const v = Number(node?.attrs?.[name]);
  return Number.isFinite(v) ? v : fallback;
};

/** 直接子节点里的文本（含 #text 与嵌套标签内的文本都会拼上，够用于 <a:t> 这类纯文本节点） */
export function textOf(node) {
  if (!node) return "";
  let out = "";
  for (const c of node.children) {
    if (c.tag === "#text") out += c.text;
    else out += textOf(c);
  }
  return out;
}
