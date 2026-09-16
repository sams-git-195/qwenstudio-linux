#!/usr/bin/env bash
# Idempotently creates (or updates the color of) the GitHub labels this repo's workflows and
# issue templates depend on: needs-human, automerge, upstream-bump (Task D3/D4 bot, spec
# docs/superpowers/specs/2026-09-15-qwen-studio-linux-design.md §12.3), dependencies
# (.github/dependabot.yml), qa-defect and packaging (issue templates).
#
# Safe to re-run any number of times -- `gh label create --force` creates the label if it's
# missing or updates its color in place if it already exists with a different one. Referenced
# from docs/BRANCH_PROTECTION.md (Task D5) as the one-time/occasional setup step for a repo
# that doesn't have these labels yet.
#
# Usage:
#   scripts/repo-setup.sh              # create/update labels on $REPO
#   scripts/repo-setup.sh --dry-run    # print what would change; makes no API calls
#
# Env:
#   REPO   "owner/repo" to operate on. Defaults to sams-git-195/qwenstudio-linux.
#
# Requires: gh (authenticated with repo admin/write access).
set -euo pipefail

REPO="${REPO:-sams-git-195/qwenstudio-linux}"
dry_run=false

usage() {
  echo "Usage: $0 [--dry-run]" >&2
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      dry_run=true
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $arg" >&2
      usage
      exit 2
      ;;
  esac
done

# name:color pairs. Colors are 6-digit hex, no leading '#' (gh's own convention).
labels=(
  "needs-human:d93f0b"
  "automerge:0e8a16"
  "upstream-bump:1d76db"
  "dependencies:0366d6"
  "qa-defect:b60205"
  "packaging:5319e7"
)

if [ "$dry_run" != true ] && ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found on PATH" >&2
  exit 1
fi

for entry in "${labels[@]}"; do
  name="${entry%%:*}"
  color="${entry##*:}"

  if [ "$dry_run" = true ]; then
    echo "[dry-run] gh label create \"$name\" --repo \"$REPO\" --color \"$color\" --force"
    continue
  fi

  echo "Ensuring label '$name' (#$color) exists on $REPO"
  gh label create "$name" --repo "$REPO" --color "$color" --force
done
