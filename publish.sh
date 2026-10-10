#!/bin/bash
# publish.sh — the one publish script.
#
# Usage (from the repository root):
#   ./publish.sh                full interactive release: finds changed books,
#                               bumps versions, prepares configs, rebuilds PDFs
#                               via ./generatepdf.sh, refreshes links, commits
#                               and pushes everything
#   ./publish.sh "message"      quick publish: commit + push all current work
#                               with the given message (private book first,
#                               then the outer repo)
#
# The full flow does, in order:
#   0. checks outer repo, private book (and storinkator later) are in sync
#      with origin — a merge conflict found here stops you BEFORE the long
#      release work, with a note to звернутися до Дена or a paste-ready
#      AI prompt describing the situation
#   1. finds changed books (uncommitted work or unpublished commits)
#   2. commits + pushes storinkator (PDFs build from storinkator.vercel.app,
#      so the site must have the latest code first)
#   3. per changed book asks: version bump (minor X.Y+1 / major / custom)
#      and whether to rebuild PDFs
#   4. prepares 3 configs per book (digital, color print, BW print):
#      creates print-bw.storinkator.json from the print-bw branch when
#      missing and forward-ports new Storinkator keys (e.g. text_tables)
#   5. generates 3 PDFs per book via ./generatepdf.sh (digital,
#      Color, BW; private book → books/private/assets)
#   6. commits + pushes everything (private book first, then outer incl.
#      the new private-book pointer)
#
# (SELFPUBLISHING.md download links are maintained by hand with:
#  bun code/scripts/release-configs.ts links --repo-root . --book <id>)
#
# Needs: git (+ bun or node >= 22 and curl for the full flow).
# On Windows run from Git Bash (ships with git); CMD/PowerShell won't work.

set -u

PROD_URL="https://storinkator.vercel.app"
SERIES="Раціональність від А до Я"

info() { echo ">>> $*"; }
note() { echo "    $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# ask_yn "prompt" default(Y/N) -> returns 0 for yes
ask_yn() {
  local prompt="$1" def="$2" hint ans
  if [ "$def" = "Y" ]; then hint="Y/n"; else hint="y/N"; fi
  printf "%s [%s]: " "$prompt" "$hint"
  ans=""
  IFS= read -r ans || true
  if [ -z "$ans" ]; then ans="$def"; fi
  case "$ans" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# repo_behind_ahead <dir> <branch>: prints "ahead behind" vs origin/<branch>,
# or nothing (return 1) when the remote branch is unreachable.
repo_behind_ahead() {
  local dir="$1" branch="$2" a b
  git -C "$dir" fetch -q origin "$branch" 2>/dev/null || return 1
  git -C "$dir" rev-parse --verify -q "origin/$branch" >/dev/null 2>&1 || return 1
  a="$(git -C "$dir" rev-list --count "origin/$branch"..HEAD 2>/dev/null)" || return 1
  b="$(git -C "$dir" rev-list --count HEAD.."origin/$branch" 2>/dev/null)" || return 1
  echo "$a $b"
}

# print_ai_prompt <label> <dir> <branch>: paste-ready problem description.
print_ai_prompt() {
  local label="$1" dir="$2" branch="$3" behind ahead st
  behind="$(git -C "$dir" log --oneline "HEAD..origin/$branch" 2>/dev/null | head -8)"
  ahead="$(git -C "$dir" log --oneline "origin/$branch"..HEAD 2>/dev/null | head -8)"
  st="$(git -C "$dir" status --porcelain 2>/dev/null | head -20)"
  echo "    ---------- скопіюй це в AI ----------"
  echo "    Я працюю в репозиторії $label ($dir), гілка $branch."
  echo "    Поки я працював, в origin/$branch з'явилися нові коміти, яких я не маю:"
  if [ -n "$behind" ]; then echo "$behind" | sed 's/^/    /'; else echo "    (немає / не вдалося прочитати)"; fi
  echo "    Мої незакомічені зміни (git status):"
  if [ -n "$st" ]; then echo "$st" | sed 's/^/    /'; else echo "    (чисто)"; fi
  echo "    Мої незапушені коміти:"
  if [ -n "$ahead" ]; then echo "$ahead" | sed 's/^/    /'; else echo "    (немає)"; fi
  echo "    git pull --ff-only не проходить або може затерти мої зміни."
  echo "    Запропонуй безпечну послідовність git-команд, щоб: 1) не втратити"
  echo "    жодної моєї зміни, 2) підтягнути зміни з origin, 3) запушити результат."
  echo "    Поясни кожен крок. Не пропонуй push --force."
  echo "    -------------------------------------"
}

# sync_check <label> <dir> <branch>: 0 = in sync (or safely fast-forwarded),
# 1 = user chose to stop. Warns early instead of failing at push time.
sync_check() {
  local label="$1" dir="$2" branch="$3" ab a b def
  ab="$(repo_behind_ahead "$dir" "$branch")" || {
    note "$label: sync check skipped (no origin/$branch?)."
    return 0
  }
  a="${ab%% *}"; b="${ab##* }"
  if [ "$b" = "0" ]; then
    [ "$a" != "0" ] && note "$label: $a unpublished commit(s), origin is in sync."
    return 0
  fi
  echo "!!! $label: origin/$branch has $b new commit(s) you don't have:"
  git -C "$dir" log --oneline "HEAD..origin/$branch" 2>/dev/null | head -8 | sed 's/^/        /'
  if [ "$a" = "0" ] && [ -z "$(git -C "$dir" status --porcelain 2>/dev/null)" ]; then
    note "working tree is clean — fast-forwarding now."
    # Never recurse: an outer pull must not reset the private-book checkout.
    if git -C "$dir" -c submodule.recurse=false pull -q --ff-only origin "$branch" 2>/dev/null; then
      note "$label: pulled, in sync now."
      return 0
    fi
    note "auto-pull failed."
  fi
  echo "    Зверніться до Дена (contact Den) — do not push by hand."
  echo "    Or paste this to an AI and follow its steps:"
  print_ai_prompt "$label" "$dir" "$branch"
  def="N"; [ "$a" = "0" ] && def="Y"
  if ! ask_yn "Continue anyway?" "$def"; then return 1; fi
  return 0
}

TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run me from inside the rationality-ua repo"
cd "$TOP" || exit 1

command -v git >/dev/null 2>&1 || die "need git on PATH"

if ! git config -f "$TOP/.gitmodules" submodule.books/private.branch >/dev/null 2>&1; then
  die "books/private is not set up here."
fi
SUBBRANCH="$(git config -f "$TOP/.gitmodules" submodule.books/private.branch)"
OUTERBRANCH="$(git rev-parse --abbrev-ref HEAD)"

# do_publish <message>: commit + push private book first, then outer.
# Private first so the outer commit records the new private-book pointer.
do_publish() {
  local MSG="$1"

  # Make sure the private book is checked out, but never touch its working
  # tree: it usually holds the very changes being published, and a plain
  # `git submodule update` aborts on them (or would reset them away).
  if [ ! -e "$TOP/books/private/.git" ]; then
    git submodule update -q --init -- books/private
  fi

  echo ">>> Committing: private book (books/private)"
  cd "$TOP/books/private" || die "cannot cd to books/private"
  if [ "$(git rev-parse --abbrev-ref HEAD)" = "HEAD" ]; then
    echo "    (attaching to branch $SUBBRANCH...)"
    DETACHED="$(git rev-parse HEAD)"
    git checkout -q "$SUBBRANCH" 2>/dev/null || git checkout -q -b "$SUBBRANCH" --track "origin/$SUBBRANCH"
    if git merge-base --is-ancestor HEAD "$DETACHED" 2>/dev/null; then
      if ! git merge -q --ff-only "$DETACHED" 2>/dev/null; then
        die "could not pick up your earlier work. Ask Den for help."
      fi
    fi
  fi
  git checkout -q "$SUBBRANCH"
  if ! git pull -q --ff-only origin "$SUBBRANCH" 2>/dev/null; then
    echo "    Someone else published at the same time and git cannot"
    echo "    combine it automatically. Зверніться до Дена — do not push by hand."
    print_ai_prompt "private book (books/private)" "$TOP/books/private" "$SUBBRANCH"
    die "publish stopped."
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

  echo ">>> Committing: outer repo ($OUTERBRANCH)"
  cd "$TOP" || die "cannot cd to $TOP"
  # Never recurse into submodules here: with submodule.recurse=true an outer
  # pull silently resets the just-published book back to the recorded commit.
  if ! git -c submodule.recurse=false pull -q --ff-only 2>/dev/null; then
    echo "    Someone else published at the same time and git cannot"
    echo "    combine it automatically. Зверніться до Дена — do not push by hand."
    print_ai_prompt "outer repo" "$TOP" "$OUTERBRANCH"
    die "publish stopped."
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
}

# ------------------------------------------------------------------ quick --
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  sed -n '2,22p' "$0"
  exit 0
fi
if [ $# -gt 0 ]; then
  do_publish "$*"
  exit 0
fi

# ------------------------------------------------------------- full flow --
command -v curl >/dev/null 2>&1 || die "need curl on PATH"
RT=""
if command -v bun >/dev/null 2>&1; then RT="bun";
elif command -v node >/dev/null 2>&1; then RT="node";
else die "need bun or node on PATH"; fi
info "runtime: $RT ($(command -v "$RT"))"

BOOKS_LIST="$("$RT" "$TOP/code/scripts/books.ts")" || die "cannot list books"
[ -z "$BOOKS_LIST" ] && die "no books found (need *.storinkator.json under books/)"
BOOK_IDS="$(echo "$BOOKS_LIST" | cut -d'|' -f1)"

book_line() {
  # book_line <id-or-dir> -> full `|` record (id|dir|ordinal|format|title) or empty
  echo "$BOOKS_LIST" | awk -F'|' -v k="$1" '$1==k || $2==k {print; exit}'
}

book_dir() { book_line "$1" | cut -d'|' -f2; }

book_title() { book_line "$1" | cut -d'|' -f5; }

is_private() {
  case "$(book_dir "$1")" in
    books/private/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Per-book release decisions as `id:key=value` lines (works for any id).
DECISIONS=""
dec_set() {
  DECISIONS="$(printf "%s\n%s:%s=%s" "$(printf "%s" "$DECISIONS" | grep -v "^$1:$2=")" "$1" "$2" "$3")"
}
dec_get() {
  printf "%s" "$DECISIONS" | grep "^$1:$2=" | tail -1 | cut -d= -f2-
}

# ---------------------------------------------------------------- changes ---
info "Step 0: checking we are in sync with origin (fetching first)..."
git fetch -q origin 2>/dev/null || note "outer fetch failed (offline?) — using local state"
git -C books/private fetch -q origin 2>/dev/null || note "private fetch failed (offline?) — using local state"
sync_check "outer repo" "$TOP" "$OUTERBRANCH" || exit 1
sync_check "private book" "$TOP/books/private" "$SUBBRANCH" || exit 1

info "Step 1: looking for changed books..."

# book_changes <id>: prints dirty files + unpublished commits; returns 0 if changed
book_changes() {
  local id="$1" dir found=1 dirty ahead
  dir="$(book_dir "$id")"
  # -c core.quotepath=false keeps Cyrillic paths readable (also set in repo config)
  if is_private "$id"; then
    sub="${dir#books/private/}"
    dirty="$(git -C books/private -c core.quotepath=false status --porcelain -- "$sub" 2>/dev/null)"
    ahead="$(git -C books/private log --oneline origin/main..HEAD -- "$sub" 2>/dev/null)"
  else
    dirty="$(git -c core.quotepath=false status --porcelain -- "$dir" 2>/dev/null)"
    ahead="$(git log --oneline origin/main..HEAD -- "$dir" 2>/dev/null)"
  fi
  if [ -n "$dirty" ]; then
    echo "    uncommitted:"
    echo "$dirty" | head -15 | sed 's/^/      /'
    found=0
  fi
  if [ -n "$ahead" ]; then
    echo "    unpublished commits:"
    echo "$ahead" | head -10 | sed 's/^/      /'
    found=0
  fi
  return "$found"
}

CHANGED_IDS=""
for id in $BOOK_IDS; do
  echo ""
  echo "  $id. $SERIES. $(book_title "$id")"
  if book_changes "$id"; then
    CHANGED_IDS="$CHANGED_IDS $id"
  else
    echo "    (no changes)"
  fi
done
echo ""

RELEASE_IDS=""
if [ -z "$CHANGED_IDS" ]; then
  if ask_yn "No changed books detected. Pick books manually?" "N"; then
    printf "Book numbers to release (e.g. '1 3'): "
    IFS= read -r RELEASE_IDS || true
  else
    echo "Nothing to do."
    exit 0
  fi
else
  echo "Changed books:$CHANGED_IDS"
  if ask_yn "Release all of them?" "Y"; then
    RELEASE_IDS="$CHANGED_IDS"
  else
    printf "Book numbers to release (e.g. '1 3'): "
    IFS= read -r RELEASE_IDS || true
  fi
fi
[ -z "$RELEASE_IDS" ] && { echo "Nothing to do."; exit 0; }

# ----------------------------------------------------------- storinkator ---
info "Step 2: storinkator must be pushed (PDFs build from $PROD_URL)"
STOR_DIR="${STORINKATOR_DIR:-$TOP/../storinkator}"
STOR_PUSHED=0
if [ ! -d "$STOR_DIR/.git" ]; then
  note "storinkator repo not found at $STOR_DIR"
  if ! ask_yn "Continue anyway (site may be outdated)?" "N"; then exit 1; fi
else
  STOR_STATUS="$(git -C "$STOR_DIR" status --porcelain)"
  STOR_AHEAD="$(git -C "$STOR_DIR" log --oneline '@{u}..HEAD' 2>/dev/null)"
  STOR_BRANCH="$(git -C "$STOR_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null)"
  if [ -n "$STOR_BRANCH" ] && [ "$STOR_BRANCH" != "HEAD" ]; then
    sync_check "storinkator" "$STOR_DIR" "$STOR_BRANCH" || exit 1
  fi
  if [ -n "$STOR_STATUS" ]; then
    echo "$STOR_STATUS" | head -20 | sed 's/^/    /'
    if ask_yn "Commit + push storinkator now?" "Y"; then
      printf "Storinkator commit message: "
      IFS= read -r STOR_MSG || true
      [ -z "$STOR_MSG" ] && die "empty message — aborting"
      (cd "$STOR_DIR" && git add -A && git commit -q -m "$STOR_MSG" && git push) \
        || die "storinkator commit/push failed"
      note "pushed."
      STOR_PUSHED=1
    else
      if ! ask_yn "Continue with UNPUSHED storinkator changes?" "N"; then exit 1; fi
    fi
  elif [ -n "$STOR_AHEAD" ]; then
    if ask_yn "Storinkator has unpublished commits. Push now?" "Y"; then
      (cd "$STOR_DIR" && git push) || die "storinkator push failed"
      STOR_PUSHED=1
    fi
  else
    note "storinkator is clean and pushed."
  fi
fi
if curl -sf -o /dev/null --max-time 10 "$PROD_URL" 2>/dev/null; then
  note "$PROD_URL is up."
else
  note "warning: $PROD_URL not reachable right now."
fi
if [ "$STOR_PUSHED" = "1" ]; then
  echo "Vercel rebuilds the site from main (~1-2 min). Generation uses the live site,"
  echo "so make sure it already picked up the push."
  printf "Press Enter when the site is fresh (auto-continues in 150s): "
  IFS= read -r -t 150 _ || true
  echo ""
else
  note "using the live site as-is."
fi

# ------------------------------------------------------------------ ask ----
cfg_value() {
  # cfg_value <config-file> <js-expr-from-cfg>  (node/bun one-liner)
  $RT -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('$1','utf8'));console.log($2);" 2>/dev/null
}

REL_DATE=""
TODAY_D="$(date +%d)"; TODAY_D="${TODAY_D#0}"
TODAY_M="$(date +%m)"; TODAY_M="${TODAY_M#0}"
TODAY_Y="$(date +%Y)"
case "$TODAY_M" in
  1) MON="січня" ;; 2) MON="лютого" ;; 3) MON="березня" ;; 4) MON="квітня" ;;
  5) MON="травня" ;; 6) MON="червня" ;; 7) MON="липня" ;; 8) MON="серпня" ;;
  9) MON="вересня" ;; 10) MON="жовтня" ;; 11) MON="листопада" ;; 12) MON="грудня" ;;
esac
REL_DATE="$TODAY_D $MON $TODAY_Y"

info "Step 3: versions, PDFs (date for all: $REL_DATE)"
for id in $RELEASE_IDS; do
  [ -n "$(book_dir "$id")" ] || die "unknown book: $id"
  dir="$(book_dir "$id")"
  echo ""
  echo "=== $SERIES. $(book_title "$id") ==="
  CUR="$(cfg_value "$TOP/$dir/digital.storinkator.json" "c.values.content_variables.TRANSLATION_VERSION")"
  [ -z "$CUR" ] && die "cannot read current version from $dir/digital.storinkator.json"
  MAJ="${CUR%%.*}"; MIN="${CUR#*.}"
  NEXT_MINOR="$MAJ.$((MIN + 1))"
  NEXT_MAJOR="$((MAJ + 1)).0"
  echo "Current version: $CUR"
  echo "  1) minor → $NEXT_MINOR   (typos, small edits)"
  echo "  2) major → $NEXT_MAJOR   (big rework)"
  echo "  3) custom (type your own X.X)"
  NEW_VER=""
  while true; do
    printf "Choose [1]: "
    IFS= read -r choice || true
    [ -z "$choice" ] && choice=1
    case "$choice" in
      1) NEW_VER="$NEXT_MINOR"; break ;;
      2) NEW_VER="$NEXT_MAJOR"; break ;;
      3)
        printf "Custom version (X.X): "
        IFS= read -r NEW_VER || true
        if printf "%s" "$NEW_VER" | grep -Eq '^[0-9]+\.[0-9]+$'; then break; fi
        echo "Must be X.X, e.g. 2.1"; NEW_VER=""
        ;;
      *) echo "Enter 1, 2 or 3." ;;
    esac
  done
  dec_set "$id" ver "$NEW_VER"
  note "new version: $NEW_VER ($REL_DATE)"

  if ask_yn "Generate 3 PDFs (digital, color, BW)?" "Y"; then dec_set "$id" pdf "yes"; else dec_set "$id" pdf "no"; fi
done

NEED_PDF=0
for id in $RELEASE_IDS; do [ "$(dec_get "$id" pdf)" = "yes" ] && NEED_PDF=1; done

# --------------------------------------------------------------- execute ---
info "Step 4: preparing configs..."
for id in $RELEASE_IDS; do
  dir="$(book_dir "$id")"
  echo ""
  echo "--- $(book_title "$id"): configs ---"
  "$RT" "$TOP/code/scripts/release-configs.ts" show --book-dir "$TOP/$dir"
  BWB_ARG="--derive-bw"
  if [ ! -f "$TOP/$dir/print-bw.storinkator.json" ] && ! is_private "$id"; then
    BWTMP="$(mktemp /tmp/bw-base.XXXXXX.json)"
    if git show "origin/print-bw:$dir/print.storinkator.json" >"$BWTMP" 2>/dev/null; then
      BWB_ARG="--bw-base $BWTMP"
    else
      note "print-bw branch blob not found — deriving BW config from print config"
    fi
  fi
  # shellcheck disable=SC2086
  "$RT" "$TOP/code/scripts/release-configs.ts" prepare \
    --book-dir "$TOP/$dir" \
    --version "$(dec_get "$id" ver)" --date "$REL_DATE" \
    $BWB_ARG || die "config prepare failed for $(book_title "$id")"
  [ -n "${BWTMP:-}" ] && rm -f "$BWTMP"; BWTMP=""
done

if [ "$NEED_PDF" = "1" ]; then
  info "Step 5: generating PDFs from $PROD_URL ..."
  PDF_IDS=""
  for id in $RELEASE_IDS; do
    [ "$(dec_get "$id" pdf)" = "yes" ] && PDF_IDS="$PDF_IDS $id"
  done
  ./generatepdf.sh --book "$PDF_IDS" --url "$PROD_URL" || die "PDF generation aborted"
fi

# --------------------------------------------------------------- publish ---
info "Step 6: commit + push"
echo ""
git -c core.quotepath=false status --porcelain | head -20 | sed 's/^/    /'
echo ""
SUGGEST="Release"
for id in $RELEASE_IDS; do
  SUGGEST="$SUGGEST $(book_title "$id") v$(dec_get "$id" ver),"
done
SUGGEST="${SUGGEST%,}"
if [ "$NEED_PDF" = "1" ]; then SUGGEST="$SUGGEST (PDFs rebuilt)"; fi
echo "Suggested message: $SUGGEST"
printf "Message (Enter = use suggested): "
IFS= read -r MSG || true
[ -z "$MSG" ] && MSG="$SUGGEST"
if ! ask_yn "Publish everything now?" "Y"; then
  echo "Stopping before publish. Your work is in the working tree —"
  echo "run ./publish.sh again or ./publish.sh \"$MSG\" when ready."
  exit 0
fi
do_publish "$MSG"
