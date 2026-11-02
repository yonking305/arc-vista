#!/usr/bin/env bash
# ArcVista 内网离线安装器 · macOS 双击入口
cd "$(dirname "$0")" || exit 1

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
  echo "[X] 未找到 Node.js。请先安装 DSH（自带 Node），或安装 Node.js 22.19+。"
  echo
  read -r -p "按回车关闭..." _
  exit 1
fi

"$NODE_BIN" install.mjs "$@"
status=$?

echo
if [ "$status" -eq 0 ]; then
  echo "安装完成。"
else
  echo "安装未完成（exit $status）。请把上面的输出发给管理员。"
fi
read -r -p "按回车关闭..." _
exit "$status"
