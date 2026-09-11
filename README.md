# CoEditor

**在 Agent 浏览器侧边栏里阅读、编辑本地文档，用批注告诉 AI 下一步怎么改、改完如何验收。**

> A local-first document review UI for AI agents. Open it in your agent's browser sidebar,
> edit documents, and leave persistent feedback on what to change and how to verify it.

批注和保留要求长期保存在本地，供已接入的 Agent 跨会话读取。

**给 AI 的修改意见，不再丢在聊天记录里。**

官网（含可交互演示）：<https://dhlbigmonster.github.io/CoEditor/> · 发布说明：[Releases](https://github.com/DHLbigmonster/CoEditor/releases)

<p align="center">
  <img src="docs/logo/logo.svg" width="120" alt="CoEditor" />
</p>

![阅读模式：暖白纸面、文档全尺寸、右侧批注栏](docs/screenshots/read-md.png)

---

## 30 秒上手

只要求 **Node.js ≥ 18**。**不需要 `npm install`** —— 运行时依赖已经内置在 `vendor/`。

```bash
git clone https://github.com/DHLbigmonster/CoEditor.git
cd CoEditor
node server.mjs ~/Documents          # 换成你要打开的本地文件夹
```

终端会打印一个 `http://127.0.0.1:<端口>` 地址，用浏览器打开即可。
也可以从界面里的「打开文件夹…」换目录。

想省一步：

```bash
npm start                            # 等价于 node cli.mjs open ./sample
```

## 日常只有一件事

**选中 → 写意见 → 自动保存 → 回到 Agent 对话继续。**

- 选中一段话，出现「批注 / 保留 / 删除线」三个按钮。
- 点「批注」，输入框里直接写：*希望这里怎么改？*
- 停手约 0.6 秒自动保存，不需要点保存、不需要记编号。
- 回到你的 Agent 对话里说「按最新批注改」——已接入的 Agent 会读到这些意见。
- 改完的条目变灰，历史保留；找不到原文的会明确说「原文已变化」，不假装成功。

「保留」表示这段内容不要动；「删除线」是**修改建议**，不是真的删除文件内容。

## 连接 Agent

左栏底部有一个状态灯：

| 显示 | 含义 |
|---|---|
| 连接 Agent | 还没有 Agent 读过这份工作区，点开有接入配置 |
| 等待 Agent 读取 | 你已经复制了接入配置，但还没有 Agent 真的读过 |
| 已连接 · 最近一次读取 … | **确实有 Agent 读过批注**（判据是一次真实的读取，不是"配置文件写没写"） |

接入方式是 MCP：把弹层里给出的 `mcpServers` 片段粘到你的 Agent 的 MCP 配置里即可。
也支持 HTTP 与 CLI 读取。

> **已验证范围（诚实说明）**：MCP stdio 服务在本地实测过握手与工具列表；
> **尚未在真实宿主 Agent 的图形界面里端到端点通**。侧边栏能力取决于宿主，
> 本项目不声称"兼容所有 Agent"。如果你在某家宿主上跑通了，欢迎开 issue 告诉我们。

## 格式能力（有边界的承诺）

跨格式的承诺是**统一的批注体验**，不是"每种格式都能随便改"。

| 格式 | 阅读 | 编辑 | 边界 |
|---|---|---|---|
| Markdown / TXT | ✅ | ✅ 全文编辑（CodeMirror，`⌘S` 写回） | 保存有 mtime 乐观锁，外部改过会被拒绝而不是覆盖 |
| HTML | ✅ 原布局，隔离 iframe（不执行脚本、外链默认阻断） | ✅ 源码编辑 + 阅读态双击纯文本段落直接改 | 只改目标文本节点，不做整段覆盖 |
| JSON / CSV | ✅ | ✅ | — |
| PDF | ✅ 连续页、官方 pdf.js 文字层、HiDPI、按需绘制 | ❌ 不做 PDF 原文编辑 | 批注 / 保留 / 删除建议；**扫描件没有文字层**，只能区域批注（不做 OCR） |
| DOCX | ✅ 尽力还原布局并说明能力 | 文字替换（受支持段落），保存为可恢复版本 | 复杂表格 / 样式 / 页眉脚不保证不变形；未知结构降级处理 |
| PPTX | 文字模式：按页读文字 | 文字替换 | **完整幻灯片排版预览需要可选的本地转换组件（LibreOffice）**，不随包提供、不自动安装；没装就走文字模式 |
| 图片 | ✅ 原比例 | ❌ | 区域批注；坐标按缩放归一化保存 |

## 数据在哪里

- 全部在本机。服务只监听 `127.0.0.1`，不联网、不上传。
- 批注写在文档目录下的 `.marginalia/annotations.json`（sidecar），**原始文件不会被批注改写**。
- 编辑保存前会在 `.marginalia/document-backups/` 留一份上一版。
- 关掉 CoEditor，批注还在；用别的编辑器打开文档，也还是原样。

## API 一览

Agent 可以走 MCP，也可以直接走 HTTP（默认 `127.0.0.1:<端口>`）：

| 端点 | 用途 |
|---|---|
| `GET /api/constraints?p=<文件>` | 读取当前生效的全部约束（Agent 最常用的入口） |
| `GET /api/annotations?p=<文件>` | 读取某文档的批注与状态 |
| `POST /api/annotations` | 新建批注 |
| `PATCH /api/annotations` | 更新状态 / 正文（带版本校验，拒绝覆盖新意见） |
| `GET /api/agent-status` | 本机 UI 用来显示连接状态 |

## 已知限制

- **多格式是入口，长期保留人工反馈才是重点。** 不要把它当浏览器自动化工具或全功能 PDF 编辑器用。
- PDF 只读；扫描件只能区域批注。
- PPTX 的完整排版预览依赖可选的 LibreOffice，需要在你自己机器上装。
- 文件树会在窄于 1100px 时自动收起；反馈栏 240–400px、文件树 180–320px 可调。
- 触控板缩放的**手感**在不同设备上仍可能有差异，欢迎反馈。

## 开发与测试

产品本身零安装即可跑。`tools/` 下的验收脚本需要开发依赖：

```bash
npm install                 # 只装 ws 与 jszip（测试用）
node --test tools/test-review.mjs
```

本项目的验收脚本走 Chrome + CDP 的真实鼠标 / 滚轮事件（不用合成 state 当证据），
批量套件见 `tools/run-battery.mjs`；近几轮的实测记录见 [`phase-report.md`](phase-report.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。

内置第三方：[jszip](https://github.com/Stuk/jszip) 3.10.1（`vendor/jszip.min.cjs`，MIT 或 GPL-3.0-or-later，原许可声明保留）；
PDF 渲染使用 [pdf.js](https://github.com/mozilla/pdf.js)（Apache-2.0，同版本主文件与 worker 位于 `public/vendor/pdfjs/`）。
