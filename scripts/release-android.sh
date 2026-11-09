#!/bin/bash
# ─── Stage an APK release with everything its licences require (runs on the build VM) ───
# Usage: bash scripts/release-android.sh <app.apk> <out-dir>
# Fails the release (exit 1) unless ALL of these hold:
#   - the APK ships the current THIRD-PARTY-NOTICES.txt (byte-equal to the repo copy, which
#     tests/unit/android-notices.test.ts keeps current) and libovpnexec.so for every ABI;
#   - GPL-2.0 (OpenVPN): the exact corresponding source goes next to the APK: the OpenVPN and
#     OpenSSL tarballs (pinned SHA-256 below; OpenVPN's signature checked too) and the build
#     script that turns them into libovpnexec.so;
#   - SHA256SUMS covers every staged file.
# Bump OVPN/OSSL here and in scripts/build-openvpn-android.sh together.
set -euo pipefail
APK=${1:?app.apk}
OUT=${2:?out dir}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

OVPN=2.6.23
OVPN_SHA=4041c709162bec1325abf5aa8cf27a255cc477c634b15ee310411c701fc40a96
OSSL=3.5.9
OSSL_SHA=603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a
OVPN_KEY=F554A3687412CFFEBDEFE0A312F5F7B42F2B01E7 # OpenVPN security mailing list

die() { echo "release-android: FAIL: $*" >&2; exit 1; }
[ -f "$APK" ] || die "no APK at $APK"
(cd "$ROOT" && node scripts/check-release-version.mjs) || die "version is not above every shipped one (docs/RELEASED-VERSIONS.txt)"
bash "$ROOT/scripts/scan-apk-secrets.sh" "$APK" || die "the APK carries an API key (scan-apk-secrets.sh)"
mkdir -p "$OUT/gpl-source"

# ─── The APK carries the current notices and OpenVPN ───
NOTICES=src/renderer/public/THIRD-PARTY-NOTICES.txt
[ -f "$ROOT/$NOTICES" ] || die "$NOTICES missing (npm run notices:android)"
unzip -p "$APK" assets/node/renderer/THIRD-PARTY-NOTICES.txt > "$OUT/.apk-notices" 2>/dev/null || die "the APK has no THIRD-PARTY-NOTICES.txt"
cmp -s "$OUT/.apk-notices" "$ROOT/$NOTICES" || die "the APK's notices differ from $NOTICES (rebuild the APK)"
rm -f "$OUT/.apk-notices"
# List once: `unzip -l | grep -q` under pipefail fails when grep exits early and unzip takes SIGPIPE,
# which read a present library as missing (0.1.4 release, rc).
LISTING=$(unzip -l "$APK")
for abi in $(grep -oE 'lib/[^/]+/libdvpnd\.so' <<<"$LISTING" | cut -d/ -f2); do
  grep -q "lib/$abi/libovpnexec.so" <<<"$LISTING" || die "lib/$abi/libovpnexec.so missing"
done

# ─── GPL-2.0 corresponding source for libovpnexec.so ───
fetch() { # $1 url, $2 file, $3 sha256 or "" (signature checked instead)
  [ -f "$OUT/gpl-source/$2" ] || curl -fsSL --retry 3 -o "$OUT/gpl-source/$2" "$1" || die "download $1"
  [ -z "$3" ] || [ "$(sha256sum "$OUT/gpl-source/$2" | cut -d' ' -f1)" = "$3" ] || die "$2 digest mismatch"
}
fetch "https://swupdate.openvpn.net/community/releases/openvpn-$OVPN.tar.gz" "openvpn-$OVPN.tar.gz" "$OVPN_SHA"
fetch "https://swupdate.openvpn.net/community/releases/openvpn-$OVPN.tar.gz.asc" "openvpn-$OVPN.tar.gz.asc" ""
fetch "https://github.com/openssl/openssl/releases/download/openssl-$OSSL/openssl-$OSSL.tar.gz" "openssl-$OSSL.tar.gz" "$OSSL_SHA"
command -v gpg >/dev/null || die "gpg is needed to check the OpenVPN signature"
GNUPGHOME=$(mktemp -d); export GNUPGHOME
trap 'rm -rf "$GNUPGHOME"' EXIT
gpg -q --keyserver hkps://keys.openpgp.org --recv-keys "$OVPN_KEY" 2>/dev/null ||
  gpg -q --keyserver hkps://keyserver.ubuntu.com --recv-keys "$OVPN_KEY" || die "could not fetch the OpenVPN signing key"
gpg -q --verify "$OUT/gpl-source/openvpn-$OVPN.tar.gz.asc" "$OUT/gpl-source/openvpn-$OVPN.tar.gz" 2>/dev/null || die "OpenVPN signature check failed"
install -m 644 "$ROOT/scripts/build-openvpn-android.sh" "$OUT/gpl-source/build-openvpn-android.sh"
cat > "$OUT/gpl-source/README.txt" <<EOF
Corresponding source for lib/<abi>/libovpnexec.so in $(basename "$APK") (GPL-2.0).
OpenVPN $OVPN and OpenSSL $OSSL, unmodified upstream tarballs, built by
build-openvpn-android.sh (NDK 27.2, API 29): it configures OpenVPN as Linux and then switches
the generated config.h to the Android target. Run: bash build-openvpn-android.sh <jniLibs-dir>
EOF

# ─── Stage the APK and the checksums ───
install -m 644 "$APK" "$OUT/$(basename "$APK")"
for f in "$OUT/$(basename "$APK")" "$OUT/gpl-source/openvpn-$OVPN.tar.gz" "$OUT/gpl-source/openvpn-$OVPN.tar.gz.asc" \
  "$OUT/gpl-source/openssl-$OSSL.tar.gz" "$OUT/gpl-source/build-openvpn-android.sh" "$OUT/gpl-source/README.txt"; do
  [ -s "$f" ] || die "missing $f"
done
(cd "$OUT" && find . -type f ! -name SHA256SUMS | sed 's|^\./||' | sort | xargs sha256sum > SHA256SUMS)
echo "release-android: OK $OUT"
cat "$OUT/SHA256SUMS"
