#!/bin/zsh
# Double-click to build dist/dsh-arcvista-<version>.tgz
set -u
cd "$(dirname "$0")"
NODE_BIN="${NODE_BIN:-/Users/yonkingwang/.hermes/node/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node，请先安装 Node.js 22+。"
  read -r "REPLY?按回车关闭窗口..."
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
"$NODE_BIN" scripts/package-tgz.mjs "$@"
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "TGZ 已生成，目录：dist/"
else
  echo "打包失败，请查看上面的日志。"
fi
read -r "REPLY?按回车关闭窗口..."
exit "$status"
