#!/usr/bin/env bash
# =============================================================================
# Point Formula/opencode-with-claude.rb at a published npm release.
#
# Downloads the tarball for the given version from the npm registry, computes
# its sha256, and rewrites the formula's `url` and `sha256` lines. Run by the
# Release workflow after `npm publish`; safe to run by hand as well.
#
# Usage:
#   scripts/update-homebrew-formula.sh [version]   # defaults to package.json
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORMULA="$REPO_ROOT/Formula/opencode-with-claude.rb"
PACKAGE="opencode-with-claude"

VERSION="${1:-$(node -p "require('$REPO_ROOT/package.json').version")}"
VERSION="${VERSION#v}"
URL="https://registry.npmjs.org/$PACKAGE/-/$PACKAGE-$VERSION.tgz"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/$PACKAGE-$VERSION.tgz"

# The registry can lag a few seconds behind `npm publish`; retry with backoff.
delay=5
for attempt in 1 2 3 4 5 6; do
  if curl -fsSL --retry 2 -o "$TARBALL" "$URL"; then
    break
  fi
  if [[ $attempt -eq 6 ]]; then
    echo "error: could not download $URL after $attempt attempts" >&2
    exit 1
  fi
  echo "tarball not available yet (attempt $attempt), retrying in ${delay}s..." >&2
  sleep "$delay"
  delay=$((delay * 2))
done

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$TARBALL" | awk '{print $1}')"
else
  SHA256="$(shasum -a 256 "$TARBALL" | awk '{print $1}')"
fi

if [[ ! "$SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "error: unexpected sha256 output: $SHA256" >&2
  exit 1
fi

# Only the leading `url`/`sha256` lines of the formula (two-space indent) are
# rewritten; anything inside `def`/`test` blocks is left alone.
sed \
  -e "s|^  url \".*\"$|  url \"$URL\"|" \
  -e "s|^  sha256 \".*\"$|  sha256 \"$SHA256\"|" \
  "$FORMULA" > "$TMP/formula.rb"

if ! grep -qF "  url \"$URL\"" "$TMP/formula.rb" || \
   ! grep -qF "  sha256 \"$SHA256\"" "$TMP/formula.rb"; then
  echo "error: failed to rewrite url/sha256 in $FORMULA" >&2
  exit 1
fi

mv "$TMP/formula.rb" "$FORMULA"
echo "Formula updated: $PACKAGE $VERSION"
echo "  url    $URL"
echo "  sha256 $SHA256"
