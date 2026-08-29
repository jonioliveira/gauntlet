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
trap 'rm -f "$STATE_FILE" "$STATE_FILE.sim"' EXIT

# Edges come from the manifest, states from Linear. `orca linear` has NO
# relation-read verb, so the graph cannot be recovered from the API — the
# manifest published alongside the epic is the only machine-readable copy.
#
# `.state.name` is fetched with `error(...)` rather than a default: `runnable`
# rejects only the states it recognises, so a null state falls through as
# runnable and the ENTIRE epic launches at once, graph ignored. A shape change
# here has to be loud.
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
               state: (.state.name // error("issue \($id) came back with no .state.name")),
               blockedBy: [ $rel[] | select(.child == $id) | .parent ]} ]' \
    > "$STATE_FILE"
}

# Best-effort: a failure notice on the board, because nobody is watching the
# runner's terminal during an unattended fan-out. Must never fail a task that
# has already failed.
note_failure() {
  orca linear comment add "$1" --body "$2" --json >/dev/null 2>&1 || true
}

# Releasing the claim is what lets a FRESH runner retry the task. Getting
# GAN_TODO_STATES wrong makes this write fail, and a swallowed failure leaves the
# task in progress forever with nothing said — so say it.
release_claim() {
  orca linear save-issue "$1" --state "${TODO_STATES%%,*}" --json >/dev/null 2>&1 \
    || echo "$1: could not release the claim to \"${TODO_STATES%%,*}\" — is GAN_TODO_STATES right for this team? The task is stuck in progress and will not be retried." >&2
}

# The exact sequence run_task performs, printed rather than run.
print_plan() {
  local TASK="$1"
  echo "orca linear save-issue $TASK --state \"${INPROGRESS_STATES%%,*}\""
  echo "orca worktree create --name $TASK --linear-issue $TASK --base-branch main --json"
  echo "herdr tab create --cwd <worktree> --label gan-$TASK --no-focus"
  echo "herdr agent start gan-$TASK --kind claude --pane <pane-id>"
  echo "herdr agent prompt gan-$TASK \"/run-sdlc $TASK\" --wait --until idle --until done --until blocked"
}

# One task's whole lifecycle, run in the background. It must never abort the
# parent: a failure here releases the claim and returns non-zero, so the run
# continues and a later, fresh runner can pick the task up again.
run_task() {
  local TASK="$1" WT="" PR="" TABJSON="" PANE="" TAB="" STATUS=""

  if ! WT="$(orca worktree create --name "$TASK" --linear-issue "$TASK" \
               --base-branch main --json | jq -r '.result.path // .path // empty')" \
     || [ -z "$WT" ]; then
    echo "worktree create failed for $TASK — releasing claim" >&2
    note_failure "$TASK" "Runner could not create a worktree for this task. Claim released; it will be retried."
    release_claim "$TASK"
    return 1
  fi

  # herdr does NOT create a pane for you: `agent start` requires an existing one,
  # and a pane's working directory comes from `tab create --cwd`, never from the
  # cwd of the process that calls `agent start`. So the tab is what puts the
  # pipeline in this task's worktree.
  TABJSON="$(herdr tab create --cwd "$WT" --label "gan-$TASK" --no-focus 2>/dev/null)" || TABJSON=""
  PANE="$(printf '%s' "$TABJSON" | jq -r '.result.root_pane.pane_id // empty' 2>/dev/null)" || PANE=""
  TAB="$(printf '%s' "$TABJSON" | jq -r '.result.tab.tab_id // empty' 2>/dev/null)" || TAB=""
  if [ -z "$PANE" ]; then
    echo "herdr tab create returned no pane id for $TASK — worktree kept at $WT, claim released" >&2
    note_failure "$TASK" "Runner could not open a herdr pane for this task. Worktree kept at $WT. Claim released; it will be retried."
    release_claim "$TASK"
    return 1
  fi

  # `--until idle --until done --until blocked` is herdr's default set, spelled out
  # because the three outcomes are NOT interchangeable here: blocked means the
  # pipeline parked at a human gate (`gate-policy: always`) having built nothing,
  # and the default --wait would return 0 for it. The status is read back rather
  # than inferred from the exit code, which cannot distinguish them.
  if herdr agent start "gan-$TASK" --kind claude --pane "$PANE" \
     && herdr agent prompt "gan-$TASK" "/run-sdlc $TASK" \
          --wait --until idle --until done --until blocked --timeout 3600000; then
    STATUS="$(herdr agent get "gan-$TASK" 2>/dev/null | jq -r '.result.agent.agent_status // empty' 2>/dev/null)" || STATUS=""

    if [ "$STATUS" = "blocked" ]; then
      # Stop for a human: nothing was built, so marking it done would be a lie,
      # and releasing the claim would relaunch it straight into the same gate.
      # Leave the claim, the pane and the worktree exactly where they are.
      echo "$TASK: pipeline is BLOCKED at a human gate — answer it in herdr pane gan-$TASK" >&2
      echo "  Worktree kept at $WT" >&2
      note_failure "$TASK" "The pipeline is waiting at a human gate in herdr pane gan-$TASK (worktree $WT). Nothing was built yet. Answer the gate, then move this issue on by hand."
      return 1
    fi

    # Best-effort: the PR URL is only discoverable if builders opened one. Never
    # let this step fail the task — the pipeline already succeeded.
    PR="$(cd "$WT" && gh pr view --json url -q .url 2>/dev/null || true)"
    if [ -n "$PR" ]; then
      orca linear attach "$TASK" --url "$PR" --title "PR/MR link" --json >/dev/null 2>&1 || true
    fi
    if ! orca linear save-issue "$TASK" --state "${DONE_STATES%%,*}" --json >/dev/null; then
      # The pipeline already succeeded and a PR may exist — releasing the claim
      # here would make the task runnable again and re-run completed work,
      # which is worse than leaving it stuck In Progress for a human to close out.
      echo "$TASK: pipeline SUCCEEDED but marking it done failed." >&2
      echo "  The work is complete${PR:+ ($PR)} — do NOT re-run it." >&2
      echo "  Finish by hand: orca linear save-issue $TASK --state \"${DONE_STATES%%,*}\"" >&2
      echo "  Worktree kept at $WT, pane gan-$TASK still open" >&2
      note_failure "$TASK" "Pipeline succeeded but the runner could not mark this issue done. The work is complete${PR:+ ($PR)} — do not re-run it; move it to done manually."
      return 1
    fi

    # `--worktree` takes a SELECTOR, not a bare id; a bare id matches nothing and
    # the worktree leaks. `name:` matches the --name used to create it above.
    orca worktree rm --worktree "name:$TASK" --json >/dev/null 2>&1 \
      || echo "$TASK: could not remove worktree (selector name:$TASK) — it is left behind at $WT" >&2
    if [ -n "$TAB" ]; then
      herdr tab close "$TAB" >/dev/null 2>&1 \
        || echo "$TASK: could not close herdr tab $TAB — close it by hand" >&2
    fi
    echo "done: $TASK${PR:+ ($PR)}"
    return 0
  fi

  # Keep the worktree for inspection. Release the claim so the task can be retried.
  echo "pipeline failed for $TASK — worktree kept at $WT, claim released" >&2
  note_failure "$TASK" "Pipeline failed. Worktree kept at $WT for inspection. Claim released; it will be retried."
  release_claim "$TASK"
  return 1
}

# ---- --dry-run: simulate the whole execution order, not just the first wave ----
# Spec §C Safety: "--dry-run prints the execution order and the exact run-sdlc
# invocations". Printing only what is runnable right now hides every task that has
# a dependency — which is exactly the ordering the user opened the flag to check.
# So mark each printed wave done in a LOCAL copy of the state and iterate.
# --max-parallel stays a grouping label here; it must not truncate the output.
sim_mark_done() {
  local ids_json
  ids_json="$(printf '%s\n' "$1" | jq -Rsc 'split("\n") | map(select(length > 0))')"
  jq --arg d "${DONE_STATES%%,*}" --argjson ids "$ids_json" \
     'map(if (.id as $i | $ids | index($i)) then (.state = $d) else . end)' \
     "$STATE_FILE" > "$STATE_FILE.sim"
  mv "$STATE_FILE.sim" "$STATE_FILE"
}

if [ "$DRY" -eq 1 ]; then
  fetch_state
  wave=0
  planned=0
  while :; do
    READY="$(bun "$REPO/src/schedule.js" runnable "$STATE_FILE" \
              "$DONE_STATES" "$CANCELED_STATES" "$INPROGRESS_STATES")"
    [ -n "$READY" ] || break
    wave=$((wave + 1))
    echo "--- wave $wave ---"
    left=0; batch=0
    while IFS= read -r TASK; do
      [ -n "$TASK" ] || continue
      if [ "$left" -le 0 ]; then
        batch=$((batch + 1)); left="$MAXP"
        echo "-- batch $batch (max-parallel $MAXP) --"
      fi
      left=$((left - 1)); planned=$((planned + 1))
      print_plan "$TASK"
    done <<< "$READY"
    sim_mark_done "$READY"
  done
  echo "planned: $planned task(s) over $wave wave(s)"
  echo "(dry run — nothing was created)"
  exit 0
fi

# ---- live run ----
# Tasks tried during THIS invocation, newline-delimited (bash 3.2 has no sets).
# A failure releases the claim so a fresh runner can retry — which also makes the
# task runnable again on the very next iteration of this loop. Without this set,
# one failure is an unbounded relaunch loop: claim, worktree, fail, release, repeat.
ATTEMPTED=""
FAILED_IDS=""
was_attempted() { printf '%s\n' "$ATTEMPTED" | grep -Fxq -- "$1"; }
mark_failed() { FAILED_IDS="${FAILED_IDS:+$FAILED_IDS }$1"; }

launched=0
failed=0
while :; do
  fetch_state
  READY="$(bun "$REPO/src/schedule.js" runnable "$STATE_FILE" \
            "$DONE_STATES" "$CANCELED_STATES" "$INPROGRESS_STATES")"
  [ -n "$READY" ] || break

  n=0
  nready=0
  PIDTASKS=""
  while IFS= read -r TASK; do
    [ -n "$TASK" ] || continue
    if was_attempted "$TASK"; then continue; fi
    nready=$((nready + 1))
    [ "$n" -ge "$MAXP" ] && break
    n=$((n + 1)); launched=$((launched + 1))
    ATTEMPTED="${ATTEMPTED}${TASK}
"

    # Claim the task BEFORE launching: an in-progress task is not runnable, so
    # this is what stops the next iteration starting it a second time.
    print_plan "$TASK"

    if ! orca linear save-issue "$TASK" --state "${INPROGRESS_STATES%%,*}" --json >/dev/null; then
      echo "$TASK: could not claim (state change failed) — is GAN_INPROGRESS_STATES right for this team?" >&2
      failed=$((failed + 1)); mark_failed "$TASK"
      continue
    fi
    run_task "$TASK" &
    PIDTASKS="$PIDTASKS $!:$TASK"
  done <<< "$READY"

  # Everything still runnable has already been tried this run; a fresh runner is
  # what retries it, not another turn of this loop.
  [ "$nready" -eq 0 ] && break

  # bash 3.2 has no `wait -n`, so this waits on the whole batch rather than
  # maintaining a sliding window of MAXP. That is the reason, not an oversight.
  for entry in $PIDTASKS; do
    if ! wait "${entry%%:*}"; then
      failed=$((failed + 1)); mark_failed "${entry#*:}"
    fi
  done
done

echo "launched: $launched, failed: $failed${FAILED_IDS:+ ($FAILED_IDS)}"
[ "$failed" -eq 0 ]
