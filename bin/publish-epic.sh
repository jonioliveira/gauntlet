#!/usr/bin/env bash
# Publish a decompose breakdown to Linear as an epic with dependency-linked child
# tasks. Two passes, because relations need ids that pass 1 creates.
#
# Pass 0 validates and writes NOTHING: a dangling reference or a cycle is caught
# before a single issue exists.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BREAKDOWN=""; DRY=0; TEAM="${GAUNTLET_LINEAR_TEAM:-JON}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --team)    TEAM="$2"; shift 2 ;;
    *)         BREAKDOWN="$1"; shift ;;
  esac
done

[ -n "$BREAKDOWN" ] || { echo "usage: publish-epic.sh <breakdown.md> [--dry-run] [--team KEY]" >&2; exit 2; }
[ -f "$BREAKDOWN" ] || { echo "no such breakdown: $BREAKDOWN" >&2; exit 2; }

# The breakdown's basename namespaces the retry uuids below, so the same task
# title in two different epics never collides on a --write-id.
SLUG="$(basename "$BREAKDOWN" .md)"
OUTDIR="$(dirname "$BREAKDOWN")"
MANIFEST="$OUTDIR/published.json"

# ---- Pass 0: validate. No writes. ----
PLAN="$(bun "$REPO/src/breakdown.js" plan "$BREAKDOWN")" || {
  echo "breakdown validation failed" >&2; exit 1;
}

# A STABLE retry id per write, so a save whose response was lost resolves to the
# same issue instead of creating a second one. It must be derived only from the
# breakdown and the title — never from the clock or a random source, because a
# retry has to produce the byte-identical uuid the lost write used.
# Returns non-zero if openssl is unavailable; every caller then simply omits
# --write-id, which is the behaviour this branch had before.
write_id_for() {
  local h
  h="$(printf '%s' "$SLUG|$1" | openssl md5 2>/dev/null | tr -d '\r' | awk '{print $NF}')"
  [ "${#h}" -eq 32 ] || return 1
  printf '%s-%s-5%s-8%s-%s\n' \
    "${h:0:8}" "${h:8:4}" "${h:13:3}" "${h:17:3}" "${h:20:12}"
}

# Title -> Linear id, kept as a JSON string rather than a bash associative array:
# macOS ships bash 3.2, which has no `declare -A`. jq is already a hard dependency
# here, so the map costs nothing extra and doubles as the manifest's own contents.
TASK_MAP='{}'
put_task() { TASK_MAP="$(jq -c --arg t "$1" --arg i "$2" '. + {($t): $i}' <<<"$TASK_MAP")"; }
get_task() { jq -r --arg t "$1" '.[$t] // empty' <<<"$TASK_MAP"; }

# Relations already written to Linear, as a JSON array of {child, parent} TITLE
# pairs. Kept separate from the manifest's `relations` (which is the PLANNED graph,
# in ids, that the runner reads) because a re-run needs to know what pass 2
# actually got through — and the runner needs the whole edge list either way.
RELS_DONE='[]'
put_rel() { RELS_DONE="$(jq -c --arg c "$1" --arg p "$2" '. + [{child:$c, parent:$p}]' <<<"$RELS_DONE")"; }
rel_done() { [ "$(jq -r --arg c "$1" --arg p "$2" 'map(select(.child==$c and .parent==$p)) | length' <<<"$RELS_DONE")" != "0" ]; }

# ---- Resume: seed from the manifest so a re-run skips, never duplicates ----
# Spec §B: "On re-run: anything in the manifest is skipped. Publishing twice is
# safe." Without this, the documented recovery from a partial publish creates a
# second epic and duplicate copies of every task that already succeeded.
EPIC_ID=""
if [ -f "$MANIFEST" ]; then
  EPIC_ID="$(jq -r '.epic // empty' "$MANIFEST")"
  TASK_MAP="$(jq -c '[.tasks[]? | {(.title): .id}] | add // {}' "$MANIFEST")"
  RELS_DONE="$(jq -c '.relationsCreated // []' "$MANIFEST")"
  echo "resuming from $MANIFEST — epic ${EPIC_ID:-<none>}, $(jq -r 'length' <<<"$TASK_MAP") task(s) already published"
fi

# ---- Pass 1: create the epic, then each task in topological order ----
EPIC_TITLE="$(echo "$PLAN" | jq -r '.epic.title')"
EPIC_BODY="$OUTDIR/.epic-body.md"
echo "$PLAN" | jq -r '.epic.summary' > "$EPIC_BODY"

if [ -n "$EPIC_ID" ]; then
  echo "skip (already published): epic $EPIC_ID"
elif [ "$DRY" -eq 0 ]; then
  EPIC_WID="$(write_id_for "EPIC: $EPIC_TITLE")" || EPIC_WID=""
  echo "orca linear save-issue --team $TEAM --title \"EPIC: $EPIC_TITLE\" --body-file $EPIC_BODY ${EPIC_WID:+--write-id $EPIC_WID} --json"
  EPIC_SAVED="$(orca linear save-issue --team "$TEAM" --title "EPIC: $EPIC_TITLE" \
                 --body-file "$EPIC_BODY" ${EPIC_WID:+--write-id "$EPIC_WID"} --json)" \
    || { echo "save-issue failed for the epic — stopping. Nothing was created." >&2; exit 1; }
  EPIC_ID="$(jq -r '.result.identifier // .identifier // empty' <<<"$EPIC_SAVED")"
  [ -n "$EPIC_ID" ] \
    || { echo "save-issue returned no identifier for the epic — stopping. Nothing was created." >&2; exit 1; }
else
  EPIC_WID="$(write_id_for "EPIC: $EPIC_TITLE")" || EPIC_WID=""
  echo "orca linear save-issue --team $TEAM --title \"EPIC: $EPIC_TITLE\" --body-file $EPIC_BODY ${EPIC_WID:+--write-id $EPIC_WID} --json"
  EPIC_ID="DRY-EPIC"
fi

# The manifest is the ONLY machine-readable copy of the dependency graph
# (`orca linear` has no relation-read verb). bin/run-epic.sh reads its edges here.
# `relations` is the PLANNED graph among known tasks — the runner needs the whole
# edge list even if pass 2 never got to write it. `relationsCreated` records what
# was actually written, and only a re-run reads it.
write_manifest() {
  local rel tasks
  rel="$(echo "$PLAN" | jq -c --argjson m "$TASK_MAP" \
    '[.edges[] | select($m[.child] and $m[.parent])
               | {child: $m[.child], parent: $m[.parent]}]')"
  tasks="$(jq -n --argjson m "$TASK_MAP" '$m | to_entries | map({title: .key, id: .value})')"
  jq -n --arg e "$EPIC_ID" --argjson t "$tasks" --argjson r "$rel" --argjson c "$RELS_DONE" \
    '{epic: $e, tasks: $t, relations: $r, relationsCreated: $c}' > "$MANIFEST"
}

# The epic exists from here on, so record it before the first task can fail —
# otherwise a failure on task 1 leaves an orphaned epic with nothing to resume from
# and the skip-on-re-run above has no epic id to seed.
if [ "$DRY" -eq 0 ]; then write_manifest; fi

while IFS= read -r title; do
  if [ -n "$(get_task "$title")" ]; then
    echo "skip (already published): \"$title\" -> $(get_task "$title")"
    continue
  fi

  BODY="$OUTDIR/.task-$(echo "$title" | tr -cd '[:alnum:]' | cut -c1-40).md"
  echo "$PLAN" | jq -r --arg t "$title" '.tasks[] | select(.title==$t) | .body' > "$BODY"
  EST="$(echo "$PLAN" | jq -r --arg t "$title" '.tasks[] | select(.title==$t) | .estimate // empty')"
  WID="$(write_id_for "$title")" || WID=""

  echo "orca linear save-issue --team $TEAM --parent-id $EPIC_ID --title \"$title\" --body-file $BODY ${EST:+--estimate $EST} ${WID:+--write-id $WID} --json"
  if [ "$DRY" -eq 0 ]; then
    SAVED="$(orca linear save-issue --team "$TEAM" --parent-id "$EPIC_ID" \
              --title "$title" --body-file "$BODY" ${EST:+--estimate "$EST"} \
              ${WID:+--write-id "$WID"} --json)" \
      || { echo "save-issue failed for \"$title\" — stopping. Created so far: $MANIFEST" >&2
           echo "Re-run the same command to resume: what is in the manifest is skipped." >&2; exit 1; }
    NEW_ID="$(jq -r '.result.identifier // .identifier // empty' <<<"$SAVED")"
    [ -n "$NEW_ID" ] \
      || { echo "save-issue returned no identifier for \"$title\" — stopping. Created so far: $MANIFEST" >&2
           echo "Re-run the same command to resume: what is in the manifest is skipped." >&2; exit 1; }
    put_task "$title" "$NEW_ID"
    write_manifest
  else
    put_task "$title" "DRY-$(echo "$title" | tr -cd '[:alnum:]' | cut -c1-8)"
  fi
done < <(echo "$PLAN" | jq -r '.order[]')

# ---- Pass 2: wire dependencies ----
while IFS=$'\t' read -r child parent; do
  if rel_done "$child" "$parent"; then
    echo "skip (already related): \"$child\" blocked-by \"$parent\""
    continue
  fi
  echo "orca linear relation add $(get_task "$child") --related $(get_task "$parent") --type blocked-by"
  if [ "$DRY" -eq 0 ]; then
    orca linear relation add "$(get_task "$child")" \
      --related "$(get_task "$parent")" --type blocked-by --json > /dev/null \
      || { echo "relation add failed for \"$child\" blocked-by \"$parent\" — stopping. Created so far: $MANIFEST" >&2
           echo "Re-run the same command to resume: what is in the manifest is skipped." >&2; exit 1; }
    put_rel "$child" "$parent"
    write_manifest
  fi
done < <(echo "$PLAN" | jq -r '.edges[] | "\(.child)\t\(.parent)"')

rm -f "$OUTDIR"/.epic-body.md "$OUTDIR"/.task-*.md
[ "$DRY" -eq 1 ] && echo "(dry run — nothing was created)" || echo "published: $MANIFEST"
