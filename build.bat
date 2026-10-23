@echo off
setlocal
pushd "%~dp0"
call npm run build -- %*
set "BUILD_EXIT=%ERRORLEVEL%"
popd
exit /b %BUILD_EXIT%
