#!/bin/sh
# 构建页面并注册 launchd 常驻服务（登录后自动启动、崩溃自动拉起）。重复执行即更新。
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE=$(command -v node)
PLIST="$HOME/Library/LaunchAgents/local.cabinet.plist"
cd "$ROOT"
pnpm install --frozen-lockfile
pnpm build
mkdir -p data
# launchd 不读 shell 配置：把当前 PATH 写进去，pi 的 bash 工具和 meegle/glab 要靠它找命令
sed -e "s|__ROOT__|$ROOT|g" -e "s|__NODE__|$NODE|g" -e "s|__PATH__|$PATH|g" deploy/cabinet.plist > "$PLIST"
SERVICE="gui/$(id -u)/local.cabinet"
launchctl bootout "$SERVICE" 2>/dev/null || true
# bootout 返回时旧进程可能还在退出（要等它收尾），这时 bootstrap 会报 5: Input/output error：等服务真正注销再注册，最多 30 秒
i=0
while launchctl print "$SERVICE" >/dev/null 2>&1 && [ $i -lt 30 ]; do
	sleep 1
	i=$((i + 1))
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "已启动：http://127.0.0.1:10086  日志：$ROOT/data/cabinet.log"
