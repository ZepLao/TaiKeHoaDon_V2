@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules (
  echo Dang cai dat thu vien lan dau...
  call npm install
)
node bang-ke.js
echo.
explorer "%~dp0ket_qua"
pause
