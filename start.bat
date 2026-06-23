@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM chat-A text MVP launcher (Windows).
REM Vendor/model are non-secret config and live here; edit to switch.
REM The API key is read from .env.local (gitignored, never committed).
set "CHAT_A_LLM_PROVIDER=deepseek"
set "CHAT_A_LLM_MODEL=deepseek-v4-flash"

REM Optional: custom persona (name/identity/OCEAN/dials/lore/user profile).
REM Copy persona.example.yaml to persona.yaml, edit it, then uncomment:
REM set "CHAT_A_PERSONA_CARD=persona.yaml"
REM Override priority: defaults < card < env. Env vars (CHAT_A_PERSONA_NAME /
REM CHAT_A_PERSONA_IDENTITY / CHAT_A_DIAL_* / CHAT_A_USER_PROFILE) override card fields.
REM
REM Disagreement (§7#3 "会反对"): she pushes back using the card's selfNotions,
REM gated by the assertiveness dial (low = compliant, high = opinionated).
REM Deterministic topic-match by default; set CHAT_A_STANCE=llm for LLM detection.
REM
REM Decision trace (§8.1 replay): CHAT_A_DECISION_TRACE=1 logs each turn's full
REM decision chain (recall/mood/stance/assembled prompt/reply) to a local SQLite
REM truth source (CHAT_A_DECISION_TRACE_DB, default chat-a-trace.db) for replay.
REM Distinct from CHAT_A_TRACE (OTel console spans); stitched by same trace_id/span_id.

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
