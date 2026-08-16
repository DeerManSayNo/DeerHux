@echo off
chcp 65001 >nul
cd /d %~dp0

echo ======================================
echo  pi-client Windows 打包脚本
echo ======================================

REM 设置代理（如果需要）
set HTTP_PROXY=http://127.0.0.1:7897
set HTTPS_PROXY=http://127.0.0.1:7897

REM 1. 下载 Node.js 二进制文件
echo.
echo [1/2] 下载 Node.js 二进制文件...
node scripts/download-node-binary.js --platform win32
if errorlevel 1 (
    echo Node 下载失败！
    pause
    exit /b 1
)

REM 2. 构建 Tauri 应用
echo.
echo [2/2] 开始构建 Tauri Windows 应用...
npm run tauri:build:win
if errorlevel 1 (
    echo Tauri 构建失败！
    pause
    exit /b 1
)

echo.
echo ======================================
echo  构建完成！
echo  输出目录: src-tauri\target\release\bundle
echo ======================================
pause
