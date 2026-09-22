@echo off
setlocal
cd /d "%~dp0"
set "TESTBENCH=%~dp0testbench"
set "URL=http://127.0.0.1:8000/index.html"

rem ---- 1. 检查测试台页面是否存在 ----
if not exist "%TESTBENCH%\index.html" (
    echo [错误] 未找到 testbench\index.html
    echo 请把本 BAT 放在项目根目录：D:\workSpace\MarketingSafetyQuiz
    goto :fail
)

rem ---- 2. 寻找 Python：先 python 后 py（不用括号块内 %errorlevel%，避免取到旧值） ----
set "PYTHON="
where python >nul 2>&1
if not errorlevel 1 set "PYTHON=python"
if not defined PYTHON (
    where py >nul 2>&1
    if not errorlevel 1 set "PYTHON=py"
)
if not defined PYTHON (
    echo [错误] 未找到 Python，请先安装 Python 并加入 PATH
    goto :fail
)

rem ---- 3. 系统自带 curl（Win10 1809 自带），用于探测服务是否可用 ----
set "CURL="
where curl >nul 2>&1
if not errorlevel 1 set "CURL=curl"

rem ---- 4. 8000 已经由测试台提供服务：不启动第二个实例，直接开浏览器 ----
if defined CURL (
    curl -s -f -o nul --max-time 2 %URL% >nul 2>&1
    if not errorlevel 1 goto :open
)

rem ---- 5. 8000 被其它程序占用：报错并停留 ----
netstat -ano | findstr ":8000" | findstr /i "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [错误] 8000端口被其他程序占用，且不是本测试台服务
    goto :fail
)

rem ---- 6. 启动服务（独立最小化窗口，关闭该窗口即停止服务） ----
echo 正在启动仿真考试测试台...
start "营销安规测试台服务" /min cmd /k %PYTHON% -m http.server 8000 --bind 127.0.0.1 --directory "%TESTBENCH%"

rem ---- 7. 等服务器真正可访问（最多约 15 秒；用 ping 做延时，兼容重定向） ----
if not defined CURL (
    ping -n 3 127.0.0.1 >nul
    goto :open
)
set /a TRIES=0
:waitloop
curl -s -f -o nul --max-time 2 %URL% >nul 2>&1
if not errorlevel 1 goto :open
set /a TRIES+=1
if %TRIES% GEQ 15 (
    echo [错误] HTTP服务启动失败：15 秒内 %URL% 不可访问
    goto :fail
)
ping -n 2 127.0.0.1 >nul
goto :waitloop

:open
start "" "%URL%"
echo 测试台已就绪：%URL%
echo 服务在最小化的“营销安规测试台服务”窗口中运行，关闭该窗口即停止服务。
ping -n 4 127.0.0.1 >nul
exit /b 0

:fail
echo.
echo 请排查后重新双击运行。
pause
exit /b 1
