@echo off
setlocal
echo Cleaning old Node/Render files from this GitHub repository...
for %%F in (server.js render.yaml package.json Dockerfile start.sh .node-version .env.example START_WINDOWS.bat CHECK_WINDOWS.bat BACKUP_WINDOWS.bat RESET_WINDOWS.bat) do (
  if exist "%%F" del /q "%%F"
)
for %%D in (src scripts seed data reference_excel) do (
  if exist "%%D" rmdir /s /q "%%D"
)
echo.
echo Done. Keep public, functions, admin_docs, README.md and the v4 guide files.
pause
