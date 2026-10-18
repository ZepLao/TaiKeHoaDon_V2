@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TaiKeHoaDon
if not exist node_modules (
  echo Dang cai dat thu vien lan dau...
  call npm install
)
node menu.js
if errorlevel 1 pause
