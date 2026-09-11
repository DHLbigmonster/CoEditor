# LOCAL-BASELINE.md — 现场事实冻结

生成：2026-09-11 · 执行：P0 开工前 · 依据：执行规格 §13.2/§13.3

> 本文件只记录**实测**。代码事实、运行实例、推断分开标注。后续每次改动后更新。

---

## 1. 仓库与工作区

| 项 | 值 |
|---|---|
| 真身路径 | `（本仓库）/marginalia` |
| 会话软链 | `（本仓库的会话软链）`（指向同一份文件） |
| HEAD | `1301e46` |
| package 版本 | `coeditor@1.5.2`（README 标题仍写 v1.3.2 —— 文案落后，待统一） |
| Node | `v22.22.2` |
| 依赖 | `jszip ^3.10.1`（运行时）、`ws ^8.21.3`（dev） |

### WIP 现状（**禁止 reset/checkout 到 HEAD**）

暂存区（staged）：

- `D  lib/pptx.mjs` —— 删除已暂存
- `M  public/app.js`、`M  public/pdf-layer.mjs`、`M  server.mjs`（另有未暂存二次修改，故显示 `MM`）

未暂存（unstaged）：`public/app.js`、`public/pdf-layer.mjs`、`server.mjs`、`.gitignore`、`package.json`、`package-lock.json`、`public/index.html`、`public/review.css`、`public/style.css`

未跟踪（untracked）：`lib/pptx.mjs`（**与暂存删除并存**）、`lib/xml.mjs`、`lib/zip.mjs`、`lib/office-text.mjs`、`public/journal.css`、`tools/test-office-text.mjs`、`tools/test-pdf-comment-lines.mjs`

统计：`git diff` 9 文件 +748/-40；`git diff --cached` 4 文件 +12/-822。

**备份**：
- 工作树快照 `（本仓库）/backups/marginalia-wip-20260911-105339.tgz`（7.3MB，排除 node_modules/.git/pptx-cache）
- git 工作树对象 `38f24cc28f8a67a20790b94901022522fbaf5fa4`（`git stash create` 产出，未改动索引/工作树）

---

## 2. 运行实例

| 实例 | PID | 端口 | vault | 状态 |
|---|---|---|---|---|
| 生产（用户正在用） | `39985` | `4478` | `（用户的私有工作区，不在公库记录）` | 活跃，`/` 200、`/api/tree` 正常 |
| 残留测试 | — | `4477` | — | 返回 502，非本轮所需，**不主动清理** |

- 生产实例 vault 是**用户的私有工作区**，只读对待，不写入、不删改。
- 本轮测试一律另起端口与独立 vault，不得复用 4478。

## 3. 资源版本

| 资源 | 版本/大小 | 备注 |
|---|---|---|
| PDF.js 主文件 | `6.3.289`（`public/vendor/pdfjs/pdf.min.mjs` 459KB） | 实测 grep |
| PDF.js worker | `6.3.289`（`pdf.worker.min.mjs` 1.27MB） | **与主文件同版本**，排除版本错配 |
| CodeMirror | `public/vendor/codemirror/codemirror.min.js` | 版本未标注，待核 |
| mammoth | `public/vendor/mammoth/mammoth.browser.min.js` | 版本未标注，待核 |
| text layer CSS | 项目自写（`public/style.css` / `review.css` 内） | **未使用 PDF.js 官方 text_layer_builder.css** —— B01 待查项 |

## 4. 测试能力

| 能力 | 状态 |
|---|---|
| Playwright / Puppeteer | **未安装**（项目与全局均无） |
| Chrome | 已安装 `/Applications/Google\ Chrome.app` |
| CDP 调试端口 9333 | 当前**未监听**（上一轮实例已退出） |
| 现有 CDP 工具 | `tools/shoot.mjs`（ws + CDP，导航/截图/取 DOM） |
| 真实触控板 | 无法自动化；按规格 §B03，CDP wheel 合成只作回归，真机验收另记 |

> 结论：B01/B02 用 **Chrome + CDP + `Input.dispatchMouseEvent`** 做真实鼠标事件链；B03 先做 CDP 合成回归，真机触控板留待人工。

## 5. 样本与格式能力（现场）

`sample/` 现有：

- PDF：`研究设计-技术附录.pdf`、`研究设计-英文摘要.pdf`
- DOCX：`项目简报-山月斋数字化试点.docx`
- PPTX：`第三方样本.pptx`（**第三方求职材料，见 §6 红线**）
- MD/HTML/图片：若干
- `.canvas` 文件：3 个（空间模式产物）

已落地的 Office 能力（09-08 WIP，未验收）：
- `lib/office-text.mjs`：`inspectOffice`（抽取 `w:t` / `a:t` 文本段）+ `patchOffice`（按段 id 写回，revision 校验）
- 对应测试 `tools/test-office-text.mjs`、`tools/test-pdf-comment-lines.mjs`

## 6. 红线

- `sample/第三方样本.pptx` 含第三方个人信息；仓库为 **public**（DHLbigmonster/CoEditor）。不得再复制进仓库、不得提交、不得用于公开演示。
- 生产 vault `（用户的私有工作区，不在公库记录）` 同上，只读。
- 测试只杀自己启动的进程；4478/39985 不得触碰。

## 7. 与执行规格的差异记录

| 规格条目 | 现场差异 | 处理 |
|---|---|---|
| §7 PPTX「缩略图+单页预览」 | 09-07 我曾开始自绘 OOXML 渲染器（`lib/zip.mjs`/`xml.mjs` 已写入） | 规格 §8.4 明确无 LibreOffice 时走**文字模式**。`office-text.mjs` 已实现该路径；自绘渲染器**停止推进**，`zip/xml.mjs` 保留供文字模式复用 |
| §1 工程交接 HEAD=1301e46 | 一致 ✅ | — |

---

*更新：2026-09-11 P0 开工*
