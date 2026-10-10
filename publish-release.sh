#!/bin/bash
# publish-release.sh — master release flow: versions, configs, PDFs, publish.
#
# Usage (from the repository root):
#   ./publish-release.sh
#
# It does, in order:
#   1. finds changed books (uncommitted work or unpublished commits)
#   2. commits + pushes storinkator (PDFs build from storinkator.vercel.app,
#      so the site must have the latest code first)
#   3. per changed book asks: version bump (minor X.Y+1 / major / custom),
#      whether to rebuild PDFs, and confirms the margin tweak
#      (inner/spine +0.5cm, outer -0.5cm in all three configs)
#   4. prepares 3 configs per book (digital, color print, BW print):
#      creates print-bw.storinkator.json from the print-bw branch when
#      missing and forward-ports new Storinkator keys (e.g. text_tables)
#   5. generates 3 PDFs per book via ./generatepdf.sh (digital,
#      145x205mm Color, 145x205mm BW; private book → books/private/assets)
#   6. refreshes the SELFPUBLISHING.md download links to the new files
#   7. publishes everything via ./publish.sh
#
# Needs: git, bun or node (>=22). Interactive — answer the prompts.

set -u

PROD_URL="https://storinkator.vercel.app"
SERIES="Раціональність від А до Я"

BOOK_IDS="1 2 3"

book_dir() {
  case "$1" in
    1) echo "books/1. Мапа і Територія" ;;
    2) echo "books/2. Як по-справжньому змінювати думку" ;;
    3) echo "books/private/3. Машина у духові" ;;
  esac
}

book_title() {
  case "$1" in
    1) echo "Книга Перша" ;;
    2) echo "Книга Друга" ;;
    3) echo "Книга Третя" ;;
  esac
}

is_private() { [ "$1" = "3" ]; }

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

TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run me from inside the rationality-ua repo"
cd "$TOP" || exit 1

RT=""
if command -v bun >/dev/null 2>&1; then RT="bun";
elif command -v node >/dev/null 2>&1; then RT="node";
else die "need bun or node on PATH"; fi
info "runtime: $RT ($(command -v "$RT"))"

command -v git >/dev/null 2>&1 || die "need git on PATH"
command -v curl >/dev/null 2>&1 || die "need curl on PATH"

# ---------------------------------------------------------------- changes ---
info "Step 1: looking for changed books (fetching first)..."
git fetch -q origin 2>/dev/null || note "outer fetch failed (offline?) — using local state"
git -C books/private fetch -q origin 2>/dev/null || note "private fetch failed (offline?) — using local state"

# book_changes <id>: prints dirty files + unpublished commits; returns 0 if changed
book_changes() {
  local id="$1" dir found=1 dirty ahead
  dir="$(book_dir "$id")"
  if is_private "$id"; then
    dirty="$(git -C books/private status --porcelain -- "3. Машина у духові" 2>/dev/null)"
    ahead="$(git -C books/private log --oneline origin/main..HEAD -- "3. Машина у духові" 2>/dev/null)"
  else
    dirty="$(git status --porcelain -- "$dir" 2>/dev/null)"
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
  # cfg_value <config-file> <js-expr-from-cfg>  (node/bun one-liner, no python)
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

# decisions (parallel indexed strings, one slot per book id via case)
VER_1=""; VER_2=""; VER_3=""
PDF_1=""; PDF_2=""; PDF_3=""
GUT_1=""; GUT_2=""; GUT_3=""
OUT_1=""; OUT_2=""; OUT_3=""

set_ver() { case "$1" in 1) VER_1="$2";; 2) VER_2="$2";; 3) VER_3="$2";; esac; }
set_pdf() { case "$1" in 1) PDF_1="$2";; 2) PDF_2="$2";; 3) PDF_3="$2";; esac; }
set_gut() { case "$1" in 1) GUT_1="$2";; 2) GUT_2="$2";; 3) GUT_3="$2";; esac; }
set_out() { case "$1" in 1) OUT_1="$2";; 2) OUT_2="$2";; 3) OUT_3="$2";; esac; }

info "Step 3: versions, PDFs, margins (date for all: $REL_DATE)"
for id in $RELEASE_IDS; do
  case "$id" in 1|2|3) ;; *) die "unknown book id: $id" ;; esac
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
  set_ver "$id" "$NEW_VER"
  note "new version: $NEW_VER ($REL_DATE)"

  if ask_yn "Generate 3 PDFs (digital, color, BW)?" "Y"; then set_pdf "$id" "yes"; else set_pdf "$id" "no"; fi

  CG="$(cfg_value "$TOP/$dir/digital.storinkator.json" "c.values.page_margin_gutter")"
  CO="$(cfg_value "$TOP/$dir/digital.storinkator.json" "c.values.page_margin_outer")"
  [ -z "$CG" ] || [ -z "$CO" ] && die "cannot read margins from $dir/digital.storinkator.json"
  NG="$($RT -e "console.log($CG + 5)" 2>/dev/null)"
  NO="$($RT -e "console.log($CO - 5)" 2>/dev/null)"
  echo "Margins now: inner(spine)=$CG outer=$CO  →  proposed: inner=$NG outer=$NO"
  if ask_yn "Apply margin tweak to all 3 configs?" "Y"; then
    set_gut "$id" "$NG"; set_out "$id" "$NO"
  else
    set_gut "$id" "$CG"; set_out "$id" "$CO"
  fi
done

get_ver() { case "$1" in 1) echo "$VER_1";; 2) echo "$VER_2";; 3) echo "$VER_3";; esac; }
get_pdf() { case "$1" in 1) echo "$PDF_1";; 2) echo "$PDF_2";; 3) echo "$PDF_3";; esac; }
get_gut() { case "$1" in 1) echo "$GUT_1";; 2) echo "$GUT_2";; 3) echo "$GUT_3";; esac; }
get_out() { case "$1" in 1) echo "$OUT_1";; 2) echo "$OUT_2";; 3) echo "$OUT_3";; esac; }

NEED_PDF=0
for id in $RELEASE_IDS; do [ "$(get_pdf "$id")" = "yes" ] && NEED_PDF=1; done

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
    --version "$(get_ver "$id")" --date "$REL_DATE" \
    --gutter "$(get_gut "$id")" --outer "$(get_out "$id")" \
    $BWB_ARG || die "config prepare failed for $(book_title "$id")"
  [ -n "${BWTMP:-}" ] && rm -f "$BWTMP"; BWTMP=""
done

if [ "$NEED_PDF" = "1" ]; then
  info "Step 5: generating PDFs from $PROD_URL ..."
  PDF_IDS=""
  for id in $RELEASE_IDS; do
    [ "$(get_pdf "$id")" = "yes" ] && PDF_IDS="$PDF_IDS $id"
  done
  ./generatepdf.sh --book "$PDF_IDS" --url "$PROD_URL" || die "PDF generation aborted"

  info "Step 6: SELFPUBLISHING.md download links..."
  for id in $RELEASE_IDS; do
    [ "$(get_pdf "$id")" = "yes" ] || continue
    is_private "$id" && continue
    if [ "$id" != "1" ] && [ "$id" != "2" ]; then continue; fi
    "$RT" "$TOP/code/scripts/release-configs.ts" links --repo-root "$TOP" --book "$id"
    if ! git diff --quiet -- SELFPUBLISHING.md; then
      git diff -- SELFPUBLISHING.md | head -30 | sed 's/^/    /'
      if ! ask_yn "Keep these link updates?" "Y"; then
        git checkout -- SELFPUBLISHING.md
        note "link updates reverted."
      fi
    fi
  done
fi

# --------------------------------------------------------------- publish ---
info "Step 7: publish via ./publish.sh"
echo ""
git status --porcelain | head -20 | sed 's/^/    /'
echo ""
SUGGEST="Release"
for id in $RELEASE_IDS; do
  SUGGEST="$SUGGEST $(book_title "$id") v$(get_ver "$id"),"
done
SUGGEST="${SUGGEST%,}"
if [ "$NEED_PDF" = "1" ]; then SUGGEST="$SUGGEST (PDFs rebuilt)"; fi
echo "Suggested message: $SUGGEST"
printf "Message (Enter = use suggested): "
IFS= read -r MSG || true
[ -z "$MSG" ] && MSG="$SUGGEST"
if ! ask_yn "Publish everything now via ./publish.sh?" "Y"; then
  echo "Stopping before publish. Your work is in the working tree —"
  echo "run ./publish-release.sh again or ./publish.sh \"$MSG\" when ready."
  exit 0
fi
./publish.sh "$MSG"
