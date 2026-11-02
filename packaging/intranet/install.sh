#!/usr/bin/env bash
# ArcVista 内网离线安装器 · macOS / Linux 入口
set -euo pipefail
cd "$(dirname "$0")"

find_node() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [ -z "${NODE_BIN:-}" ]; then
  echo "[X] 未找到 Node.js。请先安装 DSH（自带 Node），或安装 Node.js 22.19+。" >&2
  exit 1
fi

exec "$NODE_BIN" install.mjs "$@"
