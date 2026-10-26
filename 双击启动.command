#!/bin/bash
# Two stages 主图批量生成 —— Mac 双击启动
cd "$(dirname "$0")" || exit 1

# 解除系统对下载文件的隔离，否则 sharp 的原生模块会被拦
xattr -dr com.apple.quarantine . 2>/dev/null

MIN_MAJOR=20
MIN_MINOR=19

version_ok() {
  "$1" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>${MIN_MAJOR}||(a===${MIN_MAJOR}&&b>=${MIN_MINOR})?0:1)" 2>/dev/null
}

find_node() {
  local c
  local candidates=()
  if command -v node >/dev/null 2>&1; then candidates+=("$(command -v node)"); fi
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do candidates+=("$c"); done
  for c in "$HOME/Library/Application Support/fnm/node-versions"/*/installation/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node "$HOME"/.fnm/node-versions/*/installation/bin/node; do candidates+=("$c"); done
  candidates+=("$HOME/.volta/bin/node" /opt/homebrew/bin/node /usr/local/bin/node)
  # 版本号从高到低试，第一个满足要求的就用
  local found=""
  while IFS= read -r c; do
    [ -x "$c" ] || continue
    if version_ok "$c"; then found="$c"; break; fi
  done < <(for c in "${candidates[@]}"; do [ -x "$c" ] && echo "$("$c" -p 'process.versions.node' 2>/dev/null) $c"; done | sort -t. -k1,1nr -k2,2nr -k3,3nr | cut -d' ' -f2-)
  echo "$found"
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
  echo ""
  echo "没有找到 Node.js 20.19 或更新的版本。"
  echo "请到 https://nodejs.org/zh-cn 下载「长期支持版（LTS）」，安装后再双击这个文件。"
  echo ""
  read -r -p "按回车关闭窗口…"
  exit 1
fi
export PATH="$(dirname "$NODE"):$PATH"

if [ ! -d node_modules/sharp ]; then
  echo "第一次运行，正在安装图片处理组件（只需要一次，需要联网，大约 1 分钟）…"
  if ! npm install --omit=dev --no-audit --no-fund; then
    echo ""
    echo "安装失败。请检查网络后重新双击启动；如果一直失败，把这个窗口的内容截图发给维护的人。"
    read -r -p "按回车关闭窗口…"
    exit 1
  fi
fi

echo ""
echo "=============================================="
echo "  Two stages 正在运行，浏览器会自动打开页面。"
echo "  关掉这个窗口会停止服务。"
echo "=============================================="
echo ""
"$NODE" dist/server.cjs
echo ""
read -r -p "服务已停止。按回车关闭窗口…"
