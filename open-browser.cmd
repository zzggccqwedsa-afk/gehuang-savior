@echo off
setlocal
rem 用专用 user-data-dir 启动 Edge，并打开 CDP 端口供脚本读取/操作。
rem 登录一次即可长期复用；配置目录在仓库下 .browser-profile（已 gitignore）。

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
set "PROFILE=%~dp0.browser-profile"
set "URL=%~1"
if "%URL%"=="" set "URL=https://y.qq.com/"
set "PORT=%~2"
if "%PORT%"=="" set "PORT=9222"

if not exist "%PROFILE%" mkdir "%PROFILE%"
if not exist "%EDGE%" (
  echo [error] 没找到 msedge.exe，请手动改这个脚本里的 EDGE 路径
  exit /b 1
)

echo Opening Edge (CDP %PORT%, profile %PROFILE%)
start "QQMusic-CDP" "%EDGE%" --remote-debugging-port=%PORT% --user-data-dir="%PROFILE%" --no-first-run --no-default-browser-check --disable-background-networking --new-window "%URL%"
endlocal
