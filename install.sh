#!/usr/bin/env bash
# Links the skill and the built workflow into ~/.claude so edits in this repo
# take effect immediately, with no copy step to forget.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }

cd "$REPO"
bun run build

mkdir -p "$HOME/.claude/skills" "$HOME/.claude/workflows"
ln -sfn "$REPO/skill"                 "$HOME/.claude/skills/gauntlet"
ln -sfn "$REPO/dist/gauntlet.js"    "$HOME/.claude/workflows/gauntlet.js"
# The skill runs in the user's TARGET repo, where bin/ does not exist. Without
# this link, step 8 of SKILL.md names a script that is not there.
ln -sfn "$REPO/bin"                   "$HOME/.claude/gauntlet-bin"

echo "linked:"
echo "  ~/.claude/skills/gauntlet            -> $REPO/skill"
echo "  ~/.claude/workflows/gauntlet.js -> $REPO/dist/gauntlet.js"
echo "  ~/.claude/gauntlet-bin               -> $REPO/bin"
