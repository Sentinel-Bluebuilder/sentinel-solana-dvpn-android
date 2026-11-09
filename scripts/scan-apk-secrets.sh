#!/bin/bash
# ─── Release payload scan: no API key ships inside the APK (runs on the build VM) ───
# Usage: bash scripts/scan-apk-secrets.sh <app.apk>
# Unzips the APK and scans every file, native libraries (.so) and assets included, for
# api_key=<value> / api-key:<value> / apikey=<value> (any case, value of 8+ token characters,
# optionally quoted). Each hit prints as file + the match with its value redacted; any hit fails (exit 1).
# The value itself is never printed, so the scan's own output never leaks the key it found.
set -euo pipefail
APK=${1:?app.apk}
[ -f "$APK" ] || { echo "scan-apk-secrets: no APK at $APK" >&2; exit 2; }
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
unzip -q -o "$APK" -d "$T"
PAT='api[_-]?key[=:]["'"'"']?[A-Za-z0-9._~+/-]{8,}'
hits=0
while IFS= read -r -d '' f; do
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    hits=$((hits + 1))
    echo "scan-apk-secrets: HIT ${f#"$T"/}: $(printf '%s' "$m" | sed -E 's/([=:]["'"'"']?)[A-Za-z0-9._~+\/-]{8,}/\1<redacted>/')"
  done < <(grep -a -o -i -E "$PAT" "$f" 2>/dev/null || true)
done < <(find "$T" -type f -print0)
files=$(find "$T" -type f | wc -l)
if [ "$hits" -gt 0 ]; then
  echo "scan-apk-secrets: FAIL: $hits api-key value(s) in $APK ($files files scanned)" >&2
  exit 1
fi
echo "scan-apk-secrets: clean ($files files scanned, .so included)"
