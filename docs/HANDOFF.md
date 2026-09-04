# CoEditor 开发交接（HANDOFF）

> 给下一个接手的 AI（Codex / Claude）或人类协作者。读完这页即可安全动手。
> 最后更新：v0.9.0 · 2026-09-04

## 产品一句话

画布式本地文档批注层：人批注 → 批注作为**约束**回流给 Agent。三模式：**阅读**（默认，宽度自适应 + 批注侧栏）/ **编辑**（CodeMirror 源码 + HTML 实时预览）/ **画布**（Cowart 式视觉协作）。数据存 `<vault>/.marginalia/annotations.json`（唯一事实源）。

## 仓库地图

| 文件 | 职责 | 备注 |
|---|---|---|
| `server.mjs` | HTTP 服务（静态 + 全部 API） | 读失败拒绝写 / 防破坏守卫 / 写前 .prev 备份 |
| `public/app.js` | 前端主逻辑（~2100 行） | 三模式状态机在 `setWorkspaceMode` |
| `public/pdf-layer.mjs` | PDF 渲染 | HiDPI + 按需绘制（IntersectionObserver）|
| `public/style.css` | 全部样式 | 暖白主题变量在 `:root`（v0.7 块覆盖旧暗色变量）|
| `mcp-stdio.mjs` | MCP 服务（Agent 直连） | `brief()` 是约束输出的核心 |
| `cli.mjs` | CLI（open / constraints / conflicts / canvas / mcp） | |
| `tools/` | E2E 电池 + 截图管线 | 见下节 |

## 关键设计决策（动代码前必读）

1. **sidecar 是唯一事实源，四层防护**：防破坏守卫（集合不可无故减少）/ 读失败拒绝写（ENOENT 与读失败分流）/ mtime 乐观锁 / 写前 `.prev` 备份。用户显式删除时必须通过 `allowedRemovals` / `allowedCanvasRemovals` 精确放行一个目标；任何新写入方必须走 `writeSidecar`。
2. **三模式**：`state.workspaceMode`（read/edit/canvas）。阅读=自然文档流（`body:not([data-workspace-mode="canvas"])` CSS 分支）；画布=transform 世界坐标。`toWorld/worldRect/zoomAt/centerOn/fit` 都有双模式分支——**改坐标逻辑必须两个分支都改**。
3. **HTML 是双树**：`buildHtmlCoedit` 返回 `{ html, original, map }`。original 保真（脚本/URL 原样）负责写回；preview 带脚本中和 + URL 改写 + `data-coedit` 路径标记。**直改保存只写 original 序列化**——绝不能序列化 preview（会把 /api/raw 代理地址写进源文件）。
4. **事件契约**：`#page mouseup` 只在 `pending` 存在时 `stopPropagation`（否则会拦掉 region 拖框等 window 级监听——v0.7.2 踩过）。工具激活时（canvasTool!=="select"）浮条逻辑让路。
5. **PDF 文本层即时、画布惰性**：锚定/提取/批注不依赖 canvas 绘制。改渲染逻辑不要把 render 提前到全量。
6. **批次只由人推进**（完成本轮批注按钮）：外部文件变化只重锚定。**绝不自动推进**。
7. **外部修改感知先验 vault**：`GET /api/vault` 比对后才比 mtime（防同相对路径误读别的目录——真实事故 2 秒虚推 7 轮）。
8. **批注编号与已处理闭环**：显示号 `no` = "批次-序号"（0-1、0-2），组内 max+1 递增、删除不复用；全部 UI / 约束输出 / MCP `brief.no` 统一使用。Agent 处理完调用 `resolve_annotations` 标记已处理（网页自动灰显归档），**不要**让用户手动点。
9. **双编号兼容**：`id=A-xxxx` 是稳定内部主键，`no=round-seq` 是唯一面向人和 Agent 的显示号。不得把内部 ID 重新暴露到 UI。
10. **保留语义**：历史数据仍使用 `kind=highlight`，产品文案统一为「保留」。PDF 文本层 `.anchor` 的文字必须透明，避免覆盖 canvas 原字；保留不画 connector。
11. **画布事件隔离**：区域与图卡使用 pointer capture；图卡 `pointerdown` 必须阻止 viewport 的兼容 mousedown 平移。图片 load 后必须重跑 `renderRegions/drawLines`。
12. **旧便签/白板只兼容数据**：入口、渲染、Agent 约束与 Canvas 导出都已移除，不要恢复为默认功能。
13. **源码定位读真实选区，别读 `.CodeMirror-selected`**：CodeMirror 5 的 `.CodeMirror-selected` 是**绝对定位的高亮矩形 div**（`textContent` 恒为空），不是包住文字的 span。要断言「源码选中了哪段」，必须读 `cm.getSelection()` 或 `window.getSelection().toString()`（v0.9.2 因此误判过一次失败）。
14. **往 vault 写新文档一律 `wx` + 自动改名**（`/api/create-file` 重名 409；`/api/save-brief` 自动 `-2/-3`）：改写提案、润色提案、修改指令都是**人的资产**，任何新写入方都不得覆盖同名文件。
15. **先改完数组再 `join`**：`askEditWithAnnotations` 里 `prompt = lines.join()` 之后改 `lines[0]` 不会反映进 prompt（字符串是一次性的）。v0.9.3 补时间戳时踩过。

## 测试电池（发布门禁）

```bash
# 前置：headless Chrome 9333 常驻
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --remote-debugging-port=9333 \
  --user-data-dir=/tmp/marginalia-cdp-profile --no-first-run --no-sandbox --disable-setuid-sandbox \
  --disable-dev-shm-usage --disable-gpu about:blank &

node tools/run-battery.mjs   # 退出码 0 = 10/10 全绿可发布
```

- 自动清端口残留（残留实例的 root 不符即失败——EADDRINUSE 会让 spawn 静默死、API 打到别人头上）→ 备隔离 vault（副本的副本，**绝不写用户 sample**）→ 隔离端口 4401 → 顺序跑 10 套真实 CDP 鼠标 E2E → ✅/❌ 汇总。
- 单套件可独立跑：`COEDITOR_E2E_BASE=http://127.0.0.1:4401 COEDITOR_E2E_COPY=<vault副本> node tools/eval-xxx.mjs`
- **E2E 幂等两坑**：同一 vault 重复运行落点要随机偏移（旧元素拦截点击）；连续放置元素间距 > 元素尺寸。
- **CDP 调试**：`Runtime.evaluate` 取值路径是 `ev.result.value`；`exceptionDetails` 在响应顶层；iframe 内 DOM 对父文档 querySelectorAll 不可见，必须 `frame.contentDocument`。
- **⚠️ 大面积假失败先看标签页，不要怀疑代码**：调试脚本用 `/json/new` 开新标签页会把电池的 4401 页挤到后台，浏览器对后台页节流（IntersectionObserver 不触发 → PDF 惰性渲染不推进；定时器降频 → docx 解析/浮条来不及出）。表现是**只改了一个测试文件却从 8/9 跌到 4/9**。跑电池前先关掉或激活目标页：`/json/activate/<id>`。
- **排障顺序**：全红/大面积红 → ① 端口残留（EADDRINUSE 静默死）② 标签页在后台 ③ 服务活着吗 → 页面是 chrome-error 吗 → 全局 undefined 且零异常 = 页面没加载。

## 已知限制（有意不做，别当 bug 修）

- PPTX 只读渲染（重量级依赖违背零构建；截图 + 区域批注覆盖）
- PDF 内容手工编辑（定位是批注层；改 PDF 由 Agent 产新版本放旁边）
- docx 源码编辑（mammoth HTML 是单向渲染）
- CM6 迁移（CM5 单文件满足全部需求，CM6 需 esbuild）
- 语义冲突判定（当前基于锚点位置重叠）

## 下一步候选（按价值排序）

1. 真实使用反馈驱动的迭代（最高优先——产品已可用，让使用说话）
2. 批注卡在阅读模式与正文联动的增强（悬停高亮互链）
3. 多 vault 最近打开记录
4. 修改指令落盘后，让 Agent 回写「处理结果」并由 CoEditor 读取（目前 Agent 改完仍靠人去点「已处理」或调 MCP）

## 协作纪律（血泪教训浓缩）

- **动手前整目录备份**（本机历史：两次 sidecar 事故，均为空/半读数据覆盖）
- **改前先 grep 现状**（要"修"的点可能已实现）
- **并行 Edit 同一文件会互相覆盖**——批量修改用脚本或串行
- 长服务必须托管后台（`&` 起的会在会话结束被杀，Chrome 错误页会让全部 E2E 假失败）
- E2E 前置脚本失败先查：服务活着吗 → 页面是 chrome-error 吗 → 全局 undefined 且零异常 = 页面没加载
- 每次交付：commit → push origin/main → 通知用户 Cmd+R
