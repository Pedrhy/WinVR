@echo off
setlocal
cd /d "%~dp0"

if not exist "%~dp0WinVR.exe" (
    echo WinVR.exe not found. Building first...
    call "%~dp0build.bat"
    if not exist "%~dp0WinVR.exe" (
        echo Build failed. Exiting.
        pause
        exit /b 1
    )
)

echo Starting WinVR Server and Controller...
start "" "%~dp0WinVR.exe" %*

endlocal
