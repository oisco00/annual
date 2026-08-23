@echo off
cd /d "%~dp0"
echo Cleaning legacy platform files only...
for %%F in (server.js render.yaml Dockerfile START_WINDOWS.bat CHECK_WINDOWS.bat BACKUP_WINDOWS.bat RESET_WINDOWS.bat CLEAN_OLD_V3_FILES.bat) do if exist "%%F" del /q "%%F"
if exist "functions" rmdir /s /q "functions"
if exist ".github\workflows" rmdir /s /q ".github\workflows"
echo Done. Do NOT delete the hidden .git folder.
pause
