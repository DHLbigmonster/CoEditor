# CoEditor v1.6.0 · 首个公开测试版 — 发布物料

日期：2026-09-11 · 状态：**本地整理完成，尚未推送、尚未建 Release**

本文件是「发布时直接照抄」的物料与命令。执行推送/建 Release 这一步需要仓库所有者授权。

---

## 1. 干净目录验收（发布阻塞项，已通过）

用户提出的阻塞是：「不能只把现有提交推上去就算发布完成，必须用干净目录下载一次，验证没有你本机环境也能启动。」

做法：`git archive HEAD` 导出**只含被跟踪文件**的副本（等价于 GitHub 下载），**不带 `node_modules`**，直接起服务。

| 检查 | 结果 |
|---|---|
| 干净副本里没有 `node_modules` | ✅ |
| `vendor/jszip.min.cjs` 随包（运行时零安装的关键） | ✅ |
| `package.json` 的 `dependencies` 为空 | ✅ |
| 首页 / 文件树 / Agent 状态接口 | ✅ 200 |
| 打开 PDF 并渲染文字层 | ✅ |
| 真实拖选 → 批注 → 落盘 → 重新打开 → 原文出现绿色虚线 | ✅ 闭环 |
| 打开 DOCX 并读出文字（走内置 jszip） | ✅ 414 字 |
| MCP stdio：initialize / tools·list / get_review 真读到内容 | ✅ 4/4 |

**结论：`git clone` 之后 `node server.mjs <目录>` 即可运行，不需要 `npm install`。**

复跑（两条命令）：

```bash
git archive HEAD | tar -x -C /tmp/coeditor-clean
cd /tmp/coeditor-clean && COEDITOR_PORT=4599 node server.mjs ./sample
# 另开一个终端：
node tools/verify-clean-release.mjs
node tools/verify-mcp-handshake.mjs /tmp/coeditor-clean/sample /tmp/coeditor-clean/mcp-stdio.mjs
```

---

## 2. Release 说明（可直接作为 GitHub Release 正文）

**标题**：`v1.6.0 · 首个公开测试版`

```markdown
首个公开测试版。定位：在 Agent 浏览器侧边栏里阅读 / 编辑本地文档，用批注告诉 AI 下一步怎么改、改完如何验收。

## 30 秒上手
需要 Node.js ≥ 18。不需要 npm install（运行时依赖已内置）。

    git clone https://github.com/DHLbigmonster/CoEditor.git
    cd CoEditor
    node server.mjs ~/Documents

打开终端打印的 127.0.0.1 地址即可。

## 这一版做了什么
- 批注入口改成日常语言：「希望这里怎么改？」，不再要求理解批次/编号。
- 左栏底部不再暴露接口地址，改为「连接 Agent」状态灯（连接 Agent → 等待 Agent 读取 → 已连接）。
- 修掉三处阻塞：原文看不到批注、右栏点击不可靠、触控板缩放漂移与卡顿。
- 缩放从「每次整块重建页面」改为「同步改尺寸 + 位图异步锐化」（对齐 pdf.js viewer 的做法）。
- 适合宽度：窄窗口下阅读容器不再有横向溢出。
- 运行时依赖内置化，补齐此前未入库的运行时文件。

## 支持范围（有边界）
- 阅读：Markdown / TXT / HTML / JSON / CSV / PDF / DOCX / PPTX（文字模式）/ 图片
- 编辑：Markdown / TXT / HTML / JSON / CSV 全文编辑；DOCX / PPTX 文字替换
- PDF 只读，只做批注 / 保留 / 删除建议；扫描件只能区域批注（不做 OCR）
- PPTX 完整排版预览需要可选的本地组件（LibreOffice），不随包提供

## 已知限制
- MCP stdio 服务本地实测过握手与工具列表，但尚未在真实宿主 Agent 的图形界面里端到端点通；不声称兼容所有 Agent。
- 触控板缩放手感在不同设备上可能有差异。
- 多格式是入口，长期保留人工反馈才是重点；不是全功能 PDF 编辑器，也不是浏览器自动化工具。
```

---

## 3. About（仓库英文简介，GitHub About 栏）

> A local-first document review UI for AI agents. Open it in your agent's browser sidebar, edit documents, and leave persistent feedback on what to change and how to verify it.

**中文一句话**（用于中文场合分享）：

> 在 Agent 浏览器侧边栏里阅读、编辑本地文档，用批注告诉 AI 下一步怎么改、改完如何验收。

**Website 栏**：暂留空。没有独立官网之前不要填占位链接。

---

## 4. Topics（建议按此顺序添加）

```text
ai-agents
human-in-the-loop
document-review
document-annotation
local-first
mcp
pdf-viewer
pdf-annotation
markdown-editor
html-editor
```

说明：Topics 帮助相关性发现，但不保证搜索排名。不要再加 `browser-automation`、`pdf-editor` 这类会招来错用户的词。

---

## 5. 分享预览图

- 文件：`docs/screenshots/social-preview.png`（1280×640，真实界面截图，合成样本、无真人信息）
- 上传位置：GitHub 仓库 **Settings → Social preview**
- 注意：社交预览图只能从网页设置上传，REST API 不支持，需要手动传一次。

---

## 6. 执行推送与建 Release 的命令（需所有者授权后执行）

```bash
cd <本仓库>
git push origin main
git tag -a v1.6.0 -m "v1.6.0 首个公开测试版"
git push origin v1.6.0

gh release create v1.6.0 --title "v1.6.0 · 首个公开测试版" --notes-file docs/RELEASE-1.6.0.md --prerelease

# About（简介）
gh repo edit --description "A local-first document review UI for AI agents. Open it in your agent's browser sidebar, edit documents, and leave persistent feedback on what to change and how to verify it."
# Topics
gh repo edit --add-topic ai-agents,human-in-the-loop,document-review,document-annotation,local-first,mcp,pdf-viewer,pdf-annotation,markdown-editor,html-editor
```

> 仓库当前比远程领先 15 个提交；远程停在旧的 `73d43b4`，别人现在看到的还是旧版。

---

## 7. 推送前已做的红线清理

公库里不能出现的第三方 / 私有信息，已在本轮清掉：

| 位置 | 原内容 | 处理 |
|---|---|---|
| `LOCAL-BASELINE.md`、`phase-report*.md`、`CHANGELOG.md` | 用户私有工作区路径 | 替换为「用户的私有工作区，不在公库记录」 |
| `start.sh` | 默认打开的目录指向用户私有目录 | 改为仓库自带的 `./sample` |
| `sample/*.pptx` | 含第三方个人信息的样本 | 已在 `.gitignore` 中，不入库 |

---

## 8. 还没做的（按你给的顺序）

- 第 6 步「做一个简单官网」：未开始。建议等 Release 真的发出去、README 首屏验收过再做，避免官网先于能力上线。
- 在真实宿主 Agent 的 GUI 里端到端跑一次（把「尚未验证」变成「已验证」，README 才能写宿主名）。
