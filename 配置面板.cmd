@echo off
chcp 65001 >nul
title zcode-advisor 配置面板
node "%~dp0tools\setup-server.js"
pause
