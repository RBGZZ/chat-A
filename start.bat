@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM chat-A text MVP launcher (Windows).
REM Vendor/model are non-secret config and live here; edit to switch.
REM The API key is read from .env.local (gitignored, never committed).
set "CHAT_A_LLM_PROVIDER=deepseek"
set "CHAT_A_LLM_MODEL=deepseek-v4-flash"

if not exist ".env.local" (
  echo [chat-A] Missing .env.local. Create it in the project root with one line:
  echo         CHAT_A_LLM_API_KEY=sk-your-key
  echo.
  pause
  exit /b 1
)

REM Load .env.local: KEY=VALUE per line, lines starting with # are comments.
for /f "usebackq eol=# tokens=1,* delims==" %%a in (".env.local") do (
  set "%%a=%%b"
)

echo [chat-A] provider=%CHAT_A_LLM_PROVIDER% model=%CHAT_A_LLM_MODEL%
echo.
call pnpm dev

endlocal
