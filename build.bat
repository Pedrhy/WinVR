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

echo Compiling WinVR.exe with %CSC% (Embedding Web Assets for Standalone Portability) ...
%CSC% /nologo /target:winexe /optimize+ /resource:"%~dp0web\index.html",web.index.html /resource:"%~dp0web\app.css",web.app.css /resource:"%~dp0web\host.js",web.host.js /resource:"%~dp0web\vr.html",web.vr.html /resource:"%~dp0web\vr.css",web.vr.css /resource:"%~dp0web\vr.js",web.vr.js /resource:"%~dp0web\qrcode.js",web.qrcode.js /resource:"%~dp0cert.pfx",cert.pfx /r:System.dll,System.Drawing.dll,System.Windows.Forms.dll,System.Web.Extensions.dll /out:"%~dp0WinVR.exe" "%~dp0src\Program.cs"

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
