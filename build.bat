@echo off
setlocal
echo ========================================================
echo        Building WinVR - Windows Display to VR
echo ========================================================

set CSC="C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist %CSC% (
    set CSC="C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe"
)

if not exist %CSC% (
    echo [ERROR] Microsoft .NET C# compiler not found.
    pause
    exit /b 1
)

echo Compiling WinVR.exe with %CSC% ...
%CSC% /nologo /target:winexe /optimize+ /r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.Web.Extensions.dll /out:"%~dp0WinVR.exe" "%~dp0src\Program.cs"

if %ERRORLEVEL% equ 0 (
    echo.
    echo ========================================================
    echo   [SUCCESS] WinVR.exe built successfully!
    echo   Run WinVR.exe or run.bat to start.
    echo ========================================================
) else (
    echo.
    echo [ERROR] Build failed with error code %ERRORLEVEL%.
)

endlocal
