@echo off
setlocal
pushd "%~dp0"
call npm run dev -- %*
set "DEV_EXIT=%ERRORLEVEL%"
popd
exit /b %DEV_EXIT%
