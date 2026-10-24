@echo off
setlocal
chcp 65001 >nul
pushd "%~dp0"
call npm run release -- --interactive --include-worktree %*
set "BUILD_EXIT=%ERRORLEVEL%"
if not "%BUILD_EXIT%"=="0" echo Release failed. Check the error above; push or build may not have started.
popd
pause
exit /b %BUILD_EXIT%
