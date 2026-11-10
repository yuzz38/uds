@echo off
rem UDS editor: needs Python 3 (python.org)
rem Port: run.bat 9000  (default 8090; 8080 is often taken by Jenkins)
set PORT=%1
if "%PORT%"=="" set PORT=8090
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python not found. Install it from https://www.python.org/downloads/
  echo or just open index.html in the browser.
  pause
  exit /b 1
)
rem open the browser 2 seconds later, when the server is already up
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://localhost:%PORT%"
echo Editor: http://localhost:%PORT%  (close this window to stop)
python -m http.server %PORT%
pause
