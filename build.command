#!/bin/bash
set -e
cd "$(dirname "$0")"

printf '请输入发布版本号（例如 3.2.8）：'
read -r version
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  printf '版本号格式不正确。\n'
  exit 1
fi

printf '\n将版本号更新为 %s，运行测试并推送发布标签。GitHub Actions 会构建 Windows 和两种 Mac 包。\n' "$version"
npm run release -- --version "$version" --include-worktree
