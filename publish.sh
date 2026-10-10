#!/bin/bash
# publish.sh — publish ALL your work in one command.
#
# Usage (from the repository root):
#   ./publish.sh finished chapter 3
#
# It does, in order:
#   1. commits + pushes your changes inside books/private (the private book)
#   2. commits + pushes everything else, including the new private-book pointer
#
# Just run it whenever you are done working. Quotes around the message
# are optional.

set -e

if [ -z "$1" ]; then
  echo "Tell me what you did, for example:"
  echo "  ./publish.sh finished chapter 3"
  exit 1
fi
MSG="$*"

TOP="$(git rev-parse --show-toplevel)"
cd "$TOP"

if ! git config -f "$TOP/.gitmodules" submodule.books/private.branch >/dev/null 2>&1; then
  echo "ERROR: books/private is not set up here."
  exit 1
fi
SUBBRANCH="$(git config -f "$TOP/.gitmodules" submodule.books/private.branch)"
OUTERBRANCH="$(git rev-parse --abbrev-ref HEAD)"

# Make sure the private book is checked out, but never touch its working
# tree: it usually holds the very changes step 1 is about to publish, and a
# plain `git submodule update` aborts on them (or would reset them away).
if [ ! -e "$TOP/books/private/.git" ]; then
  git submodule update -q --init -- books/private
fi

echo ">>> Step 1 of 2: private book (books/private)"
cd "$TOP/books/private"
if [ "$(git rev-parse --abbrev-ref HEAD)" = "HEAD" ]; then
  echo "    (attaching to branch $SUBBRANCH...)"
  DETACHED="$(git rev-parse HEAD)"
  git checkout -q "$SUBBRANCH" 2>/dev/null || git checkout -q -b "$SUBBRANCH" --track "origin/$SUBBRANCH"
  if git merge-base --is-ancestor HEAD "$DETACHED" 2>/dev/null; then
    if ! git merge -q --ff-only "$DETACHED" 2>/dev/null; then
      echo "    ERROR: could not pick up your earlier work. Ask Den for help."
      exit 1
    fi
  fi
fi
git checkout -q "$SUBBRANCH"
if ! git pull -q --ff-only origin "$SUBBRANCH" 2>/dev/null; then
  echo "    ERROR: someone else published at the same time and git cannot"
  echo "    combine it automatically. Ask Den for help - do not push by hand."
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -q -m "$MSG"
  echo "    saved: $MSG"
else
  echo "    nothing changed."
fi
git push -q -u origin "$SUBBRANCH"
echo "    backed up."

echo ">>> Step 2 of 2: outer repo ($OUTERBRANCH)"
cd "$TOP"
# Never recurse into submodules here: with submodule.recurse=true an outer
# pull silently resets the just-published book back to the recorded commit.
if ! git -c submodule.recurse=false pull -q --ff-only 2>/dev/null; then
  echo "    ERROR: someone else published at the same time and git cannot"
  echo "    combine it automatically. Ask Den for help - do not push by hand."
  exit 1
fi
git add -A
if git diff --cached --quiet; then
  echo "    nothing changed."
else
  git commit -q -m "$MSG"
  echo "    saved: $MSG"
fi
git push -u origin "$OUTERBRANCH" --recurse-submodules=on-demand
echo "    backed up."
echo "ALL DONE - everything is safe."
