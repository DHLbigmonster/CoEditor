#!/bin/bash
# CoEditor.app 的入口脚本（放在 Contents/MacOS/CoEditor）。
#
# 为什么不直接双击 server.mjs：用户不该理解「源码 / Node / 本地服务 / 浏览器」。
# 这个脚本负责把这几件事串起来，用户只需要双击图标。
#
# 行为约定：
#   1. 已经在跑 → 只把浏览器窗口带回来，不再起第二个服务
#   2. 自动挑一个可用端口（优先沿用上次的），用户不需要处理端口冲突
#   3. 默认打开上次用过的文件夹；第一次打开则落到自带的示例目录，并让界面显示首次引导
#   4. 关掉网页不会停服务，批注还在；要停服务用界面里的「退出 CoEditor」
#   5. 所有输出写日志文件，不弹终端窗口
set -uo pipefail

CONTENTS="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="$CONTENTS/Resources/app"
NODE="$CONTENTS/Resources/node"

SUPPORT="$HOME/Library/Application Support/CoEditor"
LOG="$SUPPORT/coeditor.log"
PID_FILE="$SUPPORT/server.pid"
PORT_FILE="$SUPPORT/server.port"
mkdir -p "$SUPPORT"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

fail() {
  log "启动失败：$*"
  /usr/bin/osascript -e "display alert \"CoEditor 启动失败\" message \"$1\n\n日志：$LOG\" as critical" >/dev/null 2>&1 || true
  exit 1
}

[ -x "$NODE" ] || fail "内置运行时缺失（${NODE}）。请重新安装 CoEditor。"
[ -f "$APP_DIR/server.mjs" ] || fail "应用文件缺失（${APP_DIR}）。请重新安装 CoEditor。"

# 已有一个实例在跑？只把窗口带回来 —— 这是「重复双击」该有的行为。
if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    OLD_PORT="$(cat "$PORT_FILE" 2>/dev/null || echo 4400)"
    log "已有实例在跑（pid=$OLD_PID port=${OLD_PORT}），只打开窗口"
    open "http://127.0.0.1:$OLD_PORT/"
    exit 0
  fi
  log "清理过期 pid 文件（$OLD_PID 已不在）"
  rm -f "$PID_FILE"
fi

# 端口：先试上次用过的，不行再让系统给一个空闲的
PREFERRED="$(cat "$PORT_FILE" 2>/dev/null || echo "")"
PORT="$("$NODE" -e '
const net = require("net");
const preferred = Number(process.argv[1]) || 0;
function free(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => { try { s.close(); } catch {} resolve(0); });
    s.listen(p, "127.0.0.1", () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
(async () => {
  let p = preferred ? await free(preferred) : 0;
  if (!p) p = await free(0);
  console.log(p || "");
})();
' "${PREFERRED:-0}" 2>>"$LOG")"
[ -n "$PORT" ] || fail "找不到可用端口。"
log "选用端口 ${PORT}（上次：${PREFERRED:-无}）"

# 上次打开的文件夹；没有就落到自带示例，并标记首次运行让界面出引导
VAULT="$("$NODE" -e '
const fs = require("fs");
const path = require("path");
const [stateDir, sampleDir] = process.argv.slice(1);
let picked = "";
try {
  const list = JSON.parse(fs.readFileSync(path.join(stateDir, "recent-vaults.json"), "utf8"));
  const entries = Array.isArray(list) ? list : (list.vaults || []);
  for (const item of entries) {
    const p = typeof item === "string" ? item : item && item.path;
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) { picked = p; break; }
  }
} catch { /* 没有记录就是首次运行 */ }
if (picked) { console.log("EXISTING"); console.log(picked); }
else { console.log("FIRST_RUN"); console.log(sampleDir); }
' "$SUPPORT" "$APP_DIR/sample" 2>>"$LOG")"

VAULT_KIND="$(printf '%s' "$VAULT" | sed -n 1p)"
VAULT_PATH="$(printf '%s' "$VAULT" | sed -n 2p)"
[ -n "$VAULT_PATH" ] || fail "找不到可打开的文件夹。"
if [ "$VAULT_KIND" = "FIRST_RUN" ]; then
  log "首次运行：先用自带示例（${VAULT_PATH}），界面会提示选择自己的文件夹"
else
  log "沿用上次的文件夹：$VAULT_PATH"
fi

# 起服务。桌面模式 = 允许界面里的「退出 CoEditor」真的停服务。
export COEDITOR_PORT="$PORT"
export COEDITOR_STATE_DIR="$SUPPORT"
export COEDITOR_DESKTOP=1
[ "$VAULT_KIND" = "FIRST_RUN" ] && export COEDITOR_FIRST_RUN=1

nohup "$NODE" "$APP_DIR/server.mjs" "$VAULT_PATH" >>"$LOG" 2>&1 &
SERVER_PID=$!
printf '%s' "$SERVER_PID" >"$PID_FILE"
printf '%s' "$PORT" >"$PORT_FILE"
log "服务已启动 pid=$SERVER_PID port=$PORT vault=$VAULT_PATH"

# 等它真的能响应再打开浏览器，避免用户看到「无法连接」
READY=""
for _ in $(seq 1 100); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    rm -f "$PID_FILE"
    fail "服务启动后立刻退出，请看日志。"
  fi
  if /usr/bin/curl -fsS --max-time 1 "http://127.0.0.1:$PORT/api/app/info" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 0.1
done
[ -n "$READY" ] || { rm -f "$PID_FILE"; fail "服务在 10 秒内没有就绪。"; }

log "就绪，打开浏览器 http://127.0.0.1:$PORT/"
open "http://127.0.0.1:$PORT/"
exit 0
