#!/bin/bash
set -e
cd "$(dirname "$0")"

printf '请输入已完成 GitHub 构建的版本号（例如 3.2.8）：'
read -r version
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]]; then
  printf '版本号格式不正确。\n'
  exit 1
fi

tag="v${version}"
printf '\n正在同步 %s 的安装包到下载站...\n' "$tag"
npm run release:sync -- --tag "$tag"
printf '\n正在部署下载站到 Vercel 生产环境...\n'
npm run site:deploy
