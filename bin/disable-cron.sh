#!/usr/bin/env bash
# 停用生产批次（注释 crontab 行并重启调度器）。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRON="$ROOT/crontab"
if grep -qE '^0 0,4,8,12,16,20 ' "$CRON"; then
  sed -i 's/^0 0,4,8,12,16,20 /# baidu-feishu-batch: 0 0,4,8,12,16,20 /' "$CRON"
fi
"$ROOT/bin/start-scheduler.sh"
echo "disabled. production crontab line is commented."
