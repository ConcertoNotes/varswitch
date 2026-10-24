#!/bin/bash
cd "$(dirname "$0")" || exit 1

printf '输入版本号和本次修改说明后，运行测试并推送发布标签。GitHub Actions 会构建 Windows 和两种 Mac 包。\n'
npm run release -- --interactive --include-worktree "$@"
release_exit=$?
if [ "$release_exit" -ne 0 ]; then
  printf '\n发布失败，请查看上方错误；不能据此认为已推送或已开始构建。\n'
fi
if [ -t 0 ]; then
  read -r -p '按回车关闭窗口...' _
fi
exit "$release_exit"
