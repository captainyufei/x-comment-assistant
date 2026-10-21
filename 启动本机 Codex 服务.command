#!/bin/zsh
set -eu
cd -- "${0:A:h}"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
if [[ -x /opt/homebrew/bin/node ]]; then
  jieyiju_node=/opt/homebrew/bin/node
elif [[ -x /usr/local/bin/node ]]; then
  jieyiju_node=/usr/local/bin/node
else
  print '没有找到 Node.js 20+。请先安装 Node.js，再打开此文件。'
  read '?按回车关闭'
  exit 1
fi
"$jieyiju_node" service-manager.mjs install || { read '?按回车关闭'; exit 1; }
