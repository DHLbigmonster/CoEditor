# desktop/ — CoEditor.app 启动器

这里是 Mac 桌面版的启动器源码。产品本体仍然是网页界面，桌面版只负责把「用户不该理解的那一串」处理掉：
源码、运行时、本地服务、端口、浏览器。

## 为什么要有它

只用网页界面交付时，用户得自己完成：装 Node → 打开终端 → 敲对路径 → 记住网址 → 再想 Agent 怎么接。
这些是产品该做的事。桌面版把这五步压成一次双击。

## 交付形态

```
dist/CoEditor.app/
  Contents/
    Info.plist
    MacOS/CoEditor            ← desktop/launcher.sh（双击进入这里）
    Resources/
      node                    ← 内置 Node 运行时（约 108MB，只依赖系统库）
      AppIcon.icns
      app/                    ← 产品本体：server.mjs / lib / public / vendor / sample
```

体积换来的东西：用户机器上**不需要 Node、不需要 npm、不需要终端**。

## 启动器的行为约定

| 场景 | 行为 |
|---|---|
| 第一次双击 | 挑一个空闲端口起服务，打开浏览器；没有历史文件夹时落到自带的 `sample`，并让界面显示首次引导 |
| 再次双击（已在跑） | **不再起第二个服务**，只把浏览器窗口带回原来的地址 |
| 端口被占 | 先试上次用过的，不行就让系统给一个空闲端口 —— 用户不需要处理端口冲突 |
| 关掉网页 | 服务继续跑，批注都在；再双击即可回来 |
| 「退出 CoEditor」 | 界面左下角的按钮 → `POST /api/app/quit` → 服务停止、端口释放 |
| 上次的文件夹 | 从 `~/Library/Application Support/CoEditor/recent-vaults.json` 里挑第一个仍然存在的目录 |
| 出错 | 不静默失败：弹系统对话框并在 `~/Library/Application Support/CoEditor/coeditor.log` 留完整日志 |
| 终端窗口 | 不出现。`.app` 的 `Contents/MacOS/` 是可执行脚本，不是 `.command` |

## 构建

```bash
node tools/build-mac-app.mjs                # 用当前 node 作为内置运行时
node tools/build-mac-app.mjs --node /path/to/node --zip
```

构建脚本会顺带做一次 **ad-hoc 临时签名**（`codesign -s -`），本机双击可直接运行。
签名前会先 `xattr -cr` 清扩展属性 —— 否则 `codesign` 会以
"resource fork, Finder information, or similar detritus not allowed" 直接拒绝。

## 对外分发前必须做的三件事

```bash
# 1. 用开发者证书签名
codesign --force --deep --options runtime \
  --sign "Developer ID Application: <你的名字> (TEAMID)" dist/CoEditor.app

# 2. 打包并上传公证
ditto -c -k --keepParent dist/CoEditor.app dist/CoEditor.zip
xcrun notarytool submit dist/CoEditor.zip \
  --apple-id <账号> --team-id <TEAMID> --password <专用密码> --wait

# 3. 装订票据
xcrun stapler staple dist/CoEditor.app
```

**没做这三步之前，不要把「去系统设置里反复点允许」写进安装说明。** 那是绕过校验，不是安装流程。

## 验收

```bash
node tools/test-desktop-launcher.mjs
```

覆盖：首次启动 / 重复双击不重复起服务 / 关网页不影响服务 / 退出后服务与端口都释放 / 再双击能回来。
全程使用应用自己的 `Application Support/CoEditor` 目录，不碰任何真实工作区。

## 已知边界

- 只做了 macOS。其它平台要么另写启动器，要么先让大家用「开发者安装」。
- 内置的是本机当前的 Node 二进制（约 108MB）。换架构分发时要用对应架构的 node 重新构建。
- 没有自动更新。升级 = 下载新版覆盖「应用程序」里的 CoEditor。
