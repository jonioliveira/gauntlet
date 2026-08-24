#!/usr/bin/env bash
# Links the skill and the built workflow into ~/.claude so edits in this repo
# take effect immediately, with no copy step to forget.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }

cd "$REPO"
bun run build

mkdir -p "$HOME/.claude/skills" "$HOME/.claude/workflows"
ln -sfn "$REPO/skill"                 "$HOME/.claude/skills/gan"
ln -sfn "$REPO/dist/gan-engine.js"    "$HOME/.claude/workflows/gan-engine.js"

echo "linked:"
echo "  ~/.claude/skills/gan            -> $REPO/skill"
echo "  ~/.claude/workflows/gan-engine.js -> $REPO/dist/gan-engine.js"
