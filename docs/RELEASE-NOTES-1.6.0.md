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
