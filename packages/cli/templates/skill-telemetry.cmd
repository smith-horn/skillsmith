@echo off
REM Skillsmith skill-invocation telemetry hook — Windows Git-Bash shim.
REM
REM SMI-5012 / SMI-5020 W3.S1. Claude Code on Windows requires Git Bash,
REM so we delegate to the POSIX-sh script via `bash`. The shim itself
REM does no parsing — all logic (including the privacy-critical
REM never-read-args invariant) lives in skill-telemetry.sh.
REM
REM Stdin is piped through unchanged. Exit code is forwarded; the .sh
REM always exits 0 so this shim always exits 0 too.
REM
REM Installed at:  %USERPROFILE%\.skillsmith\hooks\skill-telemetry.cmd
REM Delegates to:  %USERPROFILE%\.skillsmith\hooks\skill-telemetry.sh

bash "%USERPROFILE%\.skillsmith\hooks\skill-telemetry.sh" %*
exit /b 0
