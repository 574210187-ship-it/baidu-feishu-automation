#!/usr/bin/env bash
# 启动 supercronic 读取本仓库 crontab（无需系统 cron 服务）。
# 默认 crontab 里生产行是注释掉的，因此启动后不会跑批次。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA="${BAIDU_FEISHU_DATA_DIR:-/workspace/baidu-feishu-data}"
BIN="$ROOT/bin/supercronic"
CRON="$ROOT/crontab"
PIDFILE="$DATA/state/supercronic.pid"
LOG="$DATA/logs/supercronic.log"
mkdir -p "$DATA/state" "$DATA/logs"

if [ ! -x "$BIN" ]; then
  echo "missing supercronic at $BIN" >&2
  echo "run: $ROOT/bin/install-supercronic.sh" >&2
  exit 1
fi

# 让 crontab 里的 run-batch.sh 指向本仓库实际路径
sed -i "s#\(/[^ ]*\)/run-batch.sh#${ROOT}/run-batch.sh#g" "$CRON"

if [ -f "$PIDFILE" ]; then
  old=$(cat "$PIDFILE" || true)
  if [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; then
    # 已在跑：supercronic 不支持 HUP 重载，直接重启以拾取 crontab 变更
    kill "$old" 2>/dev/null || true
    sleep 1
  fi
fi

nohup "$BIN" -passthrough-logs "$CRON" >>"$LOG" 2>&1 &
echo $! > "$PIDFILE"
echo "supercronic started pid=$(cat "$PIDFILE") log=$LOG"
