@echo off
chcp 65001 >nul
cd /d "%~dp0"
title TaiKeHoaDon
if not exist node_modules (
  echo Dang cai dat thu vien lan dau...
  call npm install
)

:menu
cls
echo ================================================
echo              TaiKeHoaDon
echo   Tai hoa don dien tu va xuat bang ke Excel
echo ================================================
echo.
echo   1. Tai hoa don TU DONG  (nhap khoang ngay, tool tu tim kiem)
echo   2. Tai hoa don THU CONG (tu tim kiem tren trang, nhan Enter)
echo   3. Xuat bang ke Excel   (tu cac hoa don da tai)
echo   4. Sap xep file hoa don tai tay vao mua-vao / ban-ra
echo   5. Mo thu muc ket qua (ket_qua)
echo   6. Mo thu muc nhat ky (logs)
echo   0. Thoat
echo.
set "c="
set /p c=Chon so roi nhan Enter:

if "%c%"=="1" ( node download.js & pause & goto menu )
if "%c%"=="2" ( node download.js manual & pause & goto menu )
if "%c%"=="3" ( node bang-ke.js & explorer "%~dp0ket_qua" & pause & goto menu )
if "%c%"=="4" ( node sap-xep.js & pause & goto menu )
if "%c%"=="5" ( if not exist ket_qua mkdir ket_qua & explorer "%~dp0ket_qua" & goto menu )
if "%c%"=="6" ( if not exist logs mkdir logs & explorer "%~dp0logs" & goto menu )
if "%c%"=="0" exit /b
goto menu
