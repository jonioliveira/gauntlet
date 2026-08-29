#!/usr/bin/env bash
# Publish a decompose breakdown to Linear as an epic with dependency-linked child
# tasks. Two passes, because relations need ids that pass 1 creates.
#
# Pass 0 validates and writes NOTHING: a dangling reference or a cycle is caught
# before a single issue exists.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BREAKDOWN=""; DRY=0; TEAM="${GAN_LINEAR_TEAM:-JON}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --team)    TEAM="$2"; shift 2 ;;
    *)         BREAKDOWN="$1"; shift ;;
  esac
done

[ -n "$BREAKDOWN" ] || { echo "usage: publish-epic.sh <breakdown.md> [--dry-run] [--team KEY]" >&2; exit 2; }
[ -f "$BREAKDOWN" ] || { echo "no such breakdown: $BREAKDOWN" >&2; exit 2; }

SLUG="$(basename "$BREAKDOWN" .md)"
OUTDIR="$(dirname "$BREAKDOWN")"
MANIFEST="$OUTDIR/published.json"

# ---- Pass 0: validate. No writes. ----
PLAN="$(bun "$REPO/src/breakdown.js" plan "$BREAKDOWN")" || {
  echo "breakdown validation failed" >&2; exit 1;
}

run() {
  echo "$*"
  [ "$DRY" -eq 1 ] && return 0
  "$@"
}

# ---- Pass 1: create the epic, then each task in topological order ----
EPIC_TITLE="$(echo "$PLAN" | jq -r '.epic.title')"
EPIC_BODY="$OUTDIR/.epic-body.md"
echo "$PLAN" | jq -r '.epic.summary' > "$EPIC_BODY"

echo "orca linear save-issue --team $TEAM --title \"EPIC: $EPIC_TITLE\" --body-file $EPIC_BODY --json"
if [ "$DRY" -eq 0 ]; then
  EPIC_ID="$(orca linear save-issue --team "$TEAM" --title "EPIC: $EPIC_TITLE" \
              --body-file "$EPIC_BODY" --json | jq -r '.identifier')"
else
  EPIC_ID="DRY-EPIC"
fi

# Title -> Linear id, kept as a JSON string rather than a bash associative array:
# macOS ships bash 3.2, which has no `declare -A`. jq is already a hard dependency
# here, so the map costs nothing extra and doubles as the manifest's own contents.
TASK_MAP='{}'
put_task() { TASK_MAP="$(jq -c --arg t "$1" --arg i "$2" '. + {($t): $i}' <<<"$TASK_MAP")"; }
get_task() { jq -r --arg t "$1" '.[$t] // empty' <<<"$TASK_MAP"; }

# The manifest is the ONLY machine-readable copy of the dependency graph
# (`orca linear` has no relation-read verb). bin/run-epic.sh reads its edges here.
write_manifest() {
  local rel tasks
  rel="$(echo "$PLAN" | jq -c --argjson m "$TASK_MAP" \
    '[.edges[] | select($m[.child] and $m[.parent])
               | {child: $m[.child], parent: $m[.parent]}]')"
  tasks="$(jq -n --argjson m "$TASK_MAP" '$m | to_entries | map({title: .key, id: .value})')"
  jq -n --arg e "$EPIC_ID" --argjson t "$tasks" --argjson r "$rel" \
    '{epic: $e, tasks: $t, relations: $r}' > "$MANIFEST"
}
while IFS= read -r title; do
  BODY="$OUTDIR/.task-$(echo "$title" | tr -cd '[:alnum:]' | cut -c1-40).md"
  echo "$PLAN" | jq -r --arg t "$title" '.tasks[] | select(.title==$t) | .body' > "$BODY"
  EST="$(echo "$PLAN" | jq -r --arg t "$title" '.tasks[] | select(.title==$t) | .estimate // empty')"

  echo "orca linear save-issue --team $TEAM --parent-id $EPIC_ID --title \"$title\" --body-file $BODY ${EST:+--estimate $EST} --json"
  if [ "$DRY" -eq 0 ]; then
    SAVED="$(orca linear save-issue --team "$TEAM" --parent-id "$EPIC_ID" \
              --title "$title" --body-file "$BODY" ${EST:+--estimate "$EST"} --json)" \
      || { echo "save-issue failed for \"$title\" — stopping. Created so far: $MANIFEST" >&2; exit 1; }
    NEW_ID="$(jq -r '.result.identifier // .identifier // empty' <<<"$SAVED")"
    [ -n "$NEW_ID" ] \
      || { echo "save-issue returned no identifier for \"$title\" — stopping. Created so far: $MANIFEST" >&2; exit 1; }
    put_task "$title" "$NEW_ID"
    write_manifest
  else
    put_task "$title" "DRY-$(echo "$title" | tr -cd '[:alnum:]' | cut -c1-8)"
  fi
done < <(echo "$PLAN" | jq -r '.order[]')

# ---- Pass 2: wire dependencies ----
while IFS=$'\t' read -r child parent; do
  echo "orca linear relation add $(get_task "$child") --related $(get_task "$parent") --type blocked-by"
  [ "$DRY" -eq 0 ] && orca linear relation add "$(get_task "$child")" \
      --related "$(get_task "$parent")" --type blocked-by --json > /dev/null
done < <(echo "$PLAN" | jq -r '.edges[] | "\(.child)\t\(.parent)"')

rm -f "$OUTDIR"/.epic-body.md "$OUTDIR"/.task-*.md
[ "$DRY" -eq 1 ] && echo "(dry run — nothing was created)" || echo "published: $MANIFEST"
