@echo off
title Harness Mix - Codex Native Launcher
cd /d "%~dp0"
call npm.cmd run start:codex
pause
