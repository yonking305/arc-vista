#!/bin/zsh
# Double-click in Finder to run the ArcVista release flow.
# Default: patch version bump, tests, GitHub push, npm publish.
set -u
cd "$(dirname "$0")"
NODE_BIN="${NODE_BIN:-/Users/yonkingwang/.hermes/node/bin/node}"
if [ ! -x "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "${NODE_BIN:-}" ] || [ ! -x "$NODE_BIN" ]; then
  echo "找不到 node，请先安装 Node.js 22+，或设置 NODE_BIN 环境变量。"
  read -r "REPLY?按回车关闭窗口..."
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
"$NODE_BIN" scripts/release.mjs "$@"
status=$?
echo
if [ "$status" -eq 0 ]; then
  echo "发布流程结束。"
else
  echo "发布流程失败，请查看上面的日志。"
fi
read -r "REPLY?按回车关闭窗口..."
exit "$status"
