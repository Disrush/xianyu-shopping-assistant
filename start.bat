@echo off
chcp 65001 >nul
title 闲鱼智能助手

echo ============================
echo   闲鱼智能助手 启动脚本
echo ============================
echo.

:: 检查 node 是否可用
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js ^(v18+^)
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)

:: 杀掉占用 3000 端口的进程
echo [1/4] 清理残留进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING"') do (
    taskkill /F /PID %%a >nul 2>nul
)

:: 检查依赖
if not exist node_modules (
    echo [2/4] 首次运行，安装依赖...
    npm install
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败
        pause
        exit /b 1
    )
) else (
    echo [2/4] 依赖已就绪
)

:: 安装 Playwright 浏览器
echo [3/4] 检查浏览器环境...
npx playwright install chromium >nul 2>nul

:: 启动服务
echo [4/4] 启动服务...
echo.
echo 请在浏览器中打开: http://localhost:3000
echo 首次使用请先点击「设置」配置 AI API 密钥
echo.
node server.mjs

:: 如果退出则暂停，方便查看错误
echo.
echo 服务已退出，按任意键关闭窗口...
pause >nul
