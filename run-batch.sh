#!/usr/bin/env bash
# 百度网盘→飞书三表批次的 Linux 包装器。由 supercronic/crontab 按时触发。
# 不经过 LLM。同一时间只允许一轮（flock）。
set -u
export TZ=Asia/Shanghai
export BAIDU_FEISHU_SCHEDULED_RUN=1
export BAIDU_FEISHU_REPO="${BAIDU_FEISHU_REPO:-/workspace/baidu-feishu-automation}"
export BAIDU_FEISHU_DATA_DIR="${BAIDU_FEISHU_DATA_DIR:-/workspace/baidu-feishu-data}"
export CDP_PORT="${CDP_PORT:-9333}"
export LARK_CLI_PATH="${LARK_CLI_PATH:-/usr/local/bin/lark-cli}"
export PATH="/usr/local/bin:/home/box/.local/bin:/usr/bin:/bin:$PATH"

DATA="$BAIDU_FEISHU_DATA_DIR"
LOGDIR="$DATA/logs"
LOCK="$DATA/state/batch.lock"
mkdir -p "$LOGDIR" "$DATA/state"

exec 9>"$LOCK"
if ! flock -n 9; then
  echo "$(date -Iseconds) another batch holds $LOCK, exiting" >> "$LOGDIR/wrapper.log"
  exit 0
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOGDIR/batch-$STAMP.log"
cd "$BAIDU_FEISHU_REPO" || exit 1
echo "==== start ${STAMP} pid=$$ ====" >> "$LOG"
set +e
/usr/local/bin/node scripts/run-baidu-feishu-batch.mjs >>"$LOG" 2>&1
CODE=$?
echo "==== end $(date -Iseconds) exit=$CODE ====" >> "$LOG"
ln -sfn "$(basename "$LOG")" "$LOGDIR/latest.log"
exit "$CODE"
