@echo off
:: ==============================================================================
:: SyncTab Native SQLite Host 1-Click Installer for Windows
:: ==============================================================================
echo ========================================================
echo  [SyncTab] Installing Native SQLite Bridge on Windows
echo ========================================================

python "%~dp0install.py"

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ❌ Installation encountered an error.
    echo Please make sure Python 3 is installed and added to PATH.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo ========================================================
echo 🎉 Setup Completed Successfully on Windows!
echo ========================================================
pause
