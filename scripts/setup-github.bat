@echo off
REM GitHub/Git Configuration Setup Script for Windows
REM This batch file launches the PowerShell setup script with proper execution policy
REM
REM Usage: Double-click this file or run from Command Prompt

echo.
echo GitHub/Git Setup for Windows
echo ============================
echo.
echo This will configure Git and GitHub CLI on your machine.
echo.

REM Check if running as admin (recommended but not required)
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo Note: Running without administrator privileges.
    echo       Some operations may require elevated permissions.
    echo.
)

REM Run the PowerShell script with bypassed execution policy
powershell.exe -ExecutionPolicy Bypass -File "%~dp0setup-github.ps1"

echo.
pause
