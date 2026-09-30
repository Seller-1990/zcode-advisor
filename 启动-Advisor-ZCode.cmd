@echo off
chcp 65001 >nul
title zcode-advisor 输入框角标外挂（使用期间保持此窗口开启）
node "%~dp0tools\companion\controller.cjs"
pause
