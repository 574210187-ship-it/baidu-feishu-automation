#!/usr/bin/env bash
# 启用生产批次（需百度+飞书都已登录）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRON="$ROOT/crontab"
sed -i "s#\(/[^ ]*\)/run-batch.sh#${ROOT}/run-batch.sh#g" "$CRON"
if grep -qE '^# baidu-feishu-batch: ' "$CRON"; then
  sed -i 's/^# baidu-feishu-batch: //' "$CRON"
fi
"$ROOT/bin/start-scheduler.sh"
echo "enabled. crontab production line is now active."
