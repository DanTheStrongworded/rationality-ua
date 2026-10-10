#!/bin/bash
# generatepdf.sh — regenerate book PDFs, no version/config changes.
#
# Usage:
#   ./generatepdf.sh                  ask which book(s) to rebuild
#   ./generatepdf.sh --book 1         rebuild one book (1, 2 or 3)
#   ./generatepdf.sh --book "1 3"     rebuild several books
#   ./generatepdf.sh --url <storinkator-url>   override the builder URL
#
# For each book it builds 3 files with stable names:
#   pdf/digital/<Series>. Книга <Ord>.pdf
#   pdf/print-color/<Series>. Книга <Ord> 145x205mm Color.pdf
#   pdf/print-bw/<Series>. Книга <Ord> 145x205mm BW.pdf
# Public books land in assets/, the private book in books/private/assets/.
# If print-bw.storinkator.json is missing it is created from the print-bw
# branch (or derived) keeping the current version/date/margins untouched.
# On failure it asks to retry / skip the book / abort.
#
# On Windows run from Git Bash (ships with git); CMD/PowerShell won't work.

set -u

PROD_URL="https://storinkator.vercel.app"
SERIES="Раціональність від А до Я"

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

info() { echo ">>> $*"; }
note() { echo "    $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || die "run me from inside the rationality-ua repo"
cd "$TOP" || exit 1

RT=""
if command -v bun >/dev/null 2>&1; then RT="bun";
elif command -v node >/dev/null 2>&1; then RT="node";
else die "need bun or node on PATH"; fi

BOOKS_LIST="$("$RT" "$TOP/code/scripts/books.ts")" || die "cannot list books"
[ -z "$BOOKS_LIST" ] && die "no books found (need *.storinkator.json under books/)"

URL="$PROD_URL"
BOOK_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h)
      sed -n '2,17p' "$0"
      exit 0
      ;;
    --book) BOOK_ARG="${2:-}"; [ -z "$BOOK_ARG" ] && die "--book needs a value"; shift 2 ;;
    --url) URL="${2:-}"; [ -z "$URL" ] && die "--url needs a value"; shift 2 ;;
    *) die "unknown arg: $1 (see --help)" ;;
  esac
done

IDS="$BOOK_ARG"
if [ -z "$IDS" ]; then
  echo "Which book(s) to rebuild?"
  echo "$BOOKS_LIST" | while IFS='|' read -r bid _ _ _ btitle; do
    echo "  $bid. $SERIES. $btitle"
  done
  printf "Books (e.g. '1 3', Enter = all): "
  IFS= read -r IDS || true
  if [ -z "$IDS" ]; then IDS="$(echo "$BOOKS_LIST" | cut -d'|' -f1)"; fi
fi
# normalize tokens (id or dir) to ids
RESOLVED_IDS=""
for token in $IDS; do
  rid="$(book_line "$token" | cut -d'|' -f1)"
  [ -z "$rid" ] && die "unknown book: $token"
  RESOLVED_IDS="$RESOLVED_IDS $rid"
done
IDS="$RESOLVED_IDS"

# warn when the builder site may be stale (never changes anything here)
STOR_DIR="${STORINKATOR_DIR:-$TOP/../storinkator}"
if [ -d "$STOR_DIR/.git" ]; then
  if [ -n "$(git -C "$STOR_DIR" status --porcelain)" ] || \
     [ -n "$(git -C "$STOR_DIR" log --oneline '@{u}..HEAD' 2>/dev/null)" ]; then
    note "warning: storinkator has unpublished changes — $URL may build stale PDFs."
    note "Push them first (or press Enter to continue anyway)."
    printf "Continue? [Y/n]: "
    IFS= read -r ans || true
    case "${ans:-Y}" in
      [Yy]*) ;;
      *) exit 1 ;;
    esac
  fi
fi

cfg_value() {
  # cfg_value <config-file> <js-expr-from-cfg>  (node/bun one-liner)
  $RT -e "const fs=require('fs');const c=JSON.parse(fs.readFileSync('$1','utf8'));console.log($2);" 2>/dev/null
}

for id in $IDS; do
  dir="$(book_dir "$id")"
  [ -n "$dir" ] || die "unknown book: $id"
  echo ""
  info "$(book_title "$id"): PDF rebuild from $URL"

  # print-bw config must exist for the BW variant; create it keeping
  # the current version/date/margins so this script changes nothing else
  if [ ! -f "$TOP/$dir/print-bw.storinkator.json" ]; then
    note "print-bw.storinkator.json missing — creating it (version/margins kept)"
    BWB_ARG="--derive-bw"
    if ! is_private "$id"; then
      BWTMP="$(mktemp /tmp/bw-base.XXXXXX.json)"
      if git show "origin/print-bw:$dir/print.storinkator.json" >"$BWTMP" 2>/dev/null; then
        BWB_ARG="--bw-base $BWTMP"
      else
        note "print-bw branch blob not found — deriving BW config from print config"
      fi
    fi
    CUR_VER="$(cfg_value "$TOP/$dir/digital.storinkator.json" "c.values.content_variables.TRANSLATION_VERSION")"
    CUR_DATE="$(cfg_value "$TOP/$dir/digital.storinkator.json" "c.values.content_variables.TRANSLATION_DATE")"
    CUR_GUT="$(cfg_value "$TOP/$dir/digital.storinkator.json" "c.values.page_margin_gutter")"
    CUR_OUT="$(cfg_value "$TOP/$dir/digital.storinkator.json" "c.values.page_margin_outer")"
    # shellcheck disable=SC2086
    "$RT" "$TOP/code/scripts/release-configs.ts" prepare \
      --book-dir "$TOP/$dir" \
      --version "$CUR_VER" --date "$CUR_DATE" \
      --gutter "$CUR_GUT" --outer "$CUR_OUT" \
      $BWB_ARG || die "config prepare failed for $(book_title "$id")"
    [ -n "${BWTMP:-}" ] && rm -f "$BWTMP"; BWTMP=""
  fi

  if is_private "$id"; then ASSETS="$TOP/books/private/assets"; else ASSETS="$TOP/assets"; fi
  mkdir -p "$ASSETS/pdf/digital" "$ASSETS/pdf/print-color" "$ASSETS/pdf/print-bw"
  LOG="/tmp/generatepdf-book$id.log"
  while true; do
    echo ""
    echo "--- $(book_title "$id"): digital + color + BW ---"
    if (cd "$TOP/code/scripts" && "$RT" generate-pdfs.ts --book "$id" \
        --url "$URL" --assets "$ASSETS" 2>&1 | tee "$LOG"); then
      note "PDFs done for $(book_title "$id")."
      break
    fi
    echo ""
    echo "Generation failed for $(book_title "$id") (log: $LOG):"
    tail -15 "$LOG" | sed 's/^/    /'
    printf "[r]etry / [s]kip book / [a]bort? [r]: "
    IFS= read -r ans || true
    [ -z "$ans" ] && ans="r"
    case "$ans" in
      [Ss]*) note "skipped $(book_title "$id")."; break ;;
      [Aa]*) die "aborted by user" ;;
    esac
  done
done

echo ""
info "done."
