#!/usr/bin/env bash
set -euo pipefail
cd /workspace
echo "Repo: DenysPiven/InvestCalculator"
echo
if ! command -v gh >/dev/null; then
  echo "gh missing"
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  echo "Login to GitHub (browser or paste token in the prompt):"
  gh auth login -h github.com -p https -w || gh auth login -h github.com -p https
fi
git remote remove github 2>/dev/null || true
git remote add github https://github.com/DenysPiven/InvestCalculator.git
# Prefer main; fallback create main from current HEAD
git push -u github HEAD:main
echo
echo "Done. Enable Pages: Settings → Pages → Source: GitHub Actions"
echo "Site: https://denyspiven.github.io/InvestCalculator/"
