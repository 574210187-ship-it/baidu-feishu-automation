#!/usr/bin/env bash
# 下载 aptible/supercronic v0.2.51 到本仓库 bin/supercronic。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/bin/supercronic"
VERSION="${SUPERCRONIC_VERSION:-v0.2.51}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ASSET="supercronic-linux-amd64" ;;
  aarch64|arm64) ASSET="supercronic-linux-arm64" ;;
  *)
    echo "unsupported arch: $ARCH" >&2
    exit 1
    ;;
esac
URL="https://github.com/aptible/supercronic/releases/download/${VERSION}/${ASSET}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
echo "downloading $URL"
if command -v curl >/dev/null 2>&1; then
  curl -fsSL -o "$TMP" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$TMP" "$URL"
else
  echo "need curl or wget to download supercronic" >&2
  exit 1
fi
chmod +x "$TMP"
mv "$TMP" "$DEST"
trap - EXIT
"$DEST" -version
echo "installed $DEST"
