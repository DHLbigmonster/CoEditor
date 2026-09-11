# vendor/ — 内置的第三方运行时

CoEditor 的运行时**不需要 `npm install`**。这里放的是为了让 DOCX / PPTX 的「文字模式」可用而内置的库。

| 文件 | 来源 | 版本 | 许可 |
|---|---|---|---|
| `jszip.min.cjs` | [Stuk/jszip](https://github.com/Stuk/jszip) 的 `dist/jszip.min.js` | 3.10.1 | 双许可：MIT 或 GPL-3.0-or-later（原文件头部的许可声明已保留） |

## 为什么内置而不是走 npm

CoEditor 的承诺是「下载下来、`node server.mjs` 就能跑，不联网、不装依赖」。
`jszip` 是运行时唯一需要读 zip 的地方（DOCX/PPTX 内部就是 zip），所以把它随仓库带走，
而不是要求用户先跑一次 `npm install`。

`.cjs` 后缀是有意的：本仓库 `package.json` 里 `"type": "module"`，
`.js` 会被当成 ESM 解析，而 jszip 的 dist 是 UMD/CommonJS。用 `.cjs` 让 Node 按 CommonJS 处理，
ESM 侧 `import JSZip from "../vendor/jszip.min.cjs"` 直接拿到默认导出。

## 开发依赖不在这里

`ws`（测试用的 WebSocket 客户端）与 `jszip`（`tools/` 下的测试脚本还按 npm 方式引用）
留在 `devDependencies`。跑 `tools/` 里的验收脚本才需要 `npm install`，跑产品本身不需要。
