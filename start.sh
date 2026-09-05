#!/bin/bash
# CoEditor 一键启动：./start.sh [vault目录]
# 默认打开简历目录；浏览器访问 http://127.0.0.1:4400/
cd "$(dirname "$0")"
VAULT="${1:-/Users/chaos/Desktop/简历}"
echo "CoEditor 启动中 → vault: $VAULT"
node server.mjs "$VAULT"
