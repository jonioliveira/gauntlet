#!/usr/bin/env bash
# Run every task of a Linear epic through builders' pipeline, respecting the
# dependency graph. Linear holds all the state: the runner asks what is runnable
# rather than tracking its own graph.
#
# A failed task is never moved to done, so its dependents never unblock. That is
# the whole failure policy — there is deliberately no skip logic here.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EPIC=""; DRY=0; MAXP=3
DONE_STATES="${GAN_DONE_STATES:-Done}"
CANCELED_STATES="${GAN_CANCELED_STATES:-Canceled}"
INPROGRESS_STATES="${GAN_INPROGRESS_STATES:-In Progress}"
TODO_STATES="${GAN_TODO_STATES:-Todo}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY=1; shift ;;
    --max-parallel) MAXP="$2"; shift 2 ;;
    *)              EPIC="$1"; shift ;;
  esac
done
[ -n "$EPIC" ] || { echo "usage: run-epic.sh <EPIC-ID> [--max-parallel N] [--dry-run]" >&2; exit 2; }

# The manifest is the only machine-readable copy of the dependency graph
# (`orca linear` has no relation-read verb). Accept either a manifest path or an
# epic id; an epic id is resolved by searching for the manifest that names it.
MANIFEST=""
if [ -f "$EPIC" ]; then
  MANIFEST="$EPIC"
  EPIC="$(jq -r '.epic' "$MANIFEST")"
elif [ -z "${GAN_FAKE_LINEAR:-}" ]; then
  matches=()
  for m in docs/spec/epics/*/published.json; do
    [ -f "$m" ] || continue
    epic_name="$(jq -r '.epic' "$m")"
    [ "$epic_name" = "$EPIC" ] && matches+=("$m")
  done
  case "${#matches[@]}" in
    1) MANIFEST="${matches[0]}" ;;
    0) echo "no published.json names epic $EPIC — publish first" >&2; exit 1 ;;
    *) echo "several manifests name epic $EPIC: ${matches[*]}" >&2; exit 1 ;;
  esac
fi

STATE_FILE="$(mktemp)"
trap 'rm -f "$STATE_FILE"' EXIT

# Edges come from the manifest, states from Linear. `orca linear` has NO
# relation-read verb, so the graph cannot be recovered from the API — the
# manifest published alongside the epic is the only machine-readable copy.
fetch_state() {
  if [ -n "${GAN_FAKE_LINEAR:-}" ]; then
    cp "$GAN_FAKE_LINEAR" "$STATE_FILE"
    return
  fi
  [ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST — publish first" >&2; exit 1; }
  orca linear list-issues --parent-id "$EPIC" --json \
    | jq --slurpfile m "$MANIFEST" '
        ($m[0].relations // []) as $rel
        | [ .result.issues[]
            | .identifier as $id
            | {id: $id,
               state: .state.name,
               blockedBy: [ $rel[] | select(.child == $id) | .parent ]} ]' \
    > "$STATE_FILE"
}

# One task's whole lifecycle, run in the background. It must never abort the
# parent: a failure here releases the claim and returns non-zero, so the run
# continues and the task becomes runnable again once someone fixes it.
run_task() {
  local TASK="$1" WT="" PR=""

  if ! WT="$(orca worktree create --name "$TASK" --linear-issue "$TASK" \
               --base-branch main --json | jq -r '.result.path // .path')" || [ -z "$WT" ]; then
    echo "worktree create failed for $TASK — releasing claim" >&2
    orca linear save-issue "$TASK" --state "${TODO_STATES%%,*}" --json >/dev/null 2>&1 || true
    return 1
  fi

  if ( cd "$WT" && herdr agent start "gan-$TASK" --kind claude \
        && herdr agent prompt "gan-$TASK" "/run-sdlc $TASK" --wait --timeout 3600000 ); then
    # Best-effort: the PR URL is only discoverable if builders opened one. Never
    # let this step fail the task — the pipeline already succeeded.
    PR="$(cd "$WT" && gh pr view --json url -q .url 2>/dev/null || true)"
    if [ -n "$PR" ]; then
      orca linear attach "$TASK" --url "$PR" --title "PR/MR link" --json >/dev/null 2>&1 || true
    fi
    orca linear save-issue "$TASK" --state "${DONE_STATES%%,*}" --json >/dev/null
    orca worktree rm --worktree "$TASK" --json >/dev/null 2>&1 || true
    echo "done: $TASK${PR:+ ($PR)}"
    return 0
  fi

  # Keep the worktree for inspection. Release the claim so the task can be retried.
  echo "pipeline failed for $TASK — worktree kept at $WT, claim released" >&2
  orca linear save-issue "$TASK" --state "${TODO_STATES%%,*}" --json >/dev/null 2>&1 || true
  return 1
}

launched=0
failed=0
while :; do
  fetch_state
  READY="$(bun "$REPO/src/schedule.js" runnable "$STATE_FILE" \
            "$DONE_STATES" "$CANCELED_STATES" "$INPROGRESS_STATES")"
  [ -n "$READY" ] || break

  n=0
  PIDS=""
  while IFS= read -r TASK; do
    [ -n "$TASK" ] || continue
    [ "$n" -ge "$MAXP" ] && break
    n=$((n+1)); launched=$((launched+1))

    # Claim the task BEFORE launching: an in-progress task is not runnable, so
    # this is what stops the next iteration starting it a second time.
    echo "orca linear save-issue $TASK --state \"${INPROGRESS_STATES%%,*}\""
    echo "orca worktree create --name $TASK --linear-issue $TASK --base-branch main --json"
    echo "herdr agent start gan-$TASK --kind claude"
    echo "herdr agent prompt gan-$TASK \"/run-sdlc $TASK\" --wait"

    if [ "$DRY" -eq 0 ]; then
      orca linear save-issue "$TASK" --state "${INPROGRESS_STATES%%,*}" --json >/dev/null
      run_task "$TASK" &
      PIDS="$PIDS $!"
    fi
  done <<< "$READY"

  if [ "$DRY" -eq 1 ]; then echo "(dry run — nothing was created)"; break; fi
  for pid in $PIDS; do
    wait "$pid" || failed=$((failed + 1))
  done
done

echo "launched: $launched, failed: $failed"
[ "$failed" -eq 0 ]
