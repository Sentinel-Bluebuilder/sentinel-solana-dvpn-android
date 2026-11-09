#!/bin/bash
# ─── Fetch the protocol programs for the APK (runs on test-host) ───
# Usage: bash fetch-android-deps.sh <jniLibs-dir> [lock-out.json]
# Same versions as the Windows app (build/deps.lock.json). Official Android release builds, checked against the
# publisher's own digest; where no Android build exists for an ABI (V2Ray x86_64) it is built from
# the tagged source with GOOS=android. Writes <abi>/lib<name>.so and a lock with every sha256.
set -euo pipefail
OUT=${1:?jniLibs dir}
LOCK=${2:-$OUT/../android-deps.lock.json}
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

HY2=2.13.0
V2RAY=5.53.0
XRAY=26.3.27

declare -a ROWS=()
# Licence + source for the APK notices (scripts/android-notices.mjs; texts in android/licenses/).
meta() { # $1 name, $2 version -> license licenseUrl sourceUrl
  case $1 in
    hysteria2) echo "MIT https://github.com/apernet/hysteria/blob/app/v$2/LICENSE.md https://github.com/apernet/hysteria/tree/app/v$2" ;;
    xray) echo "MPL-2.0 https://github.com/XTLS/Xray-core/blob/v$2/LICENSE https://github.com/XTLS/Xray-core/tree/v$2" ;;
    v2ray) echo "MIT https://github.com/v2fly/v2ray-core/blob/v$2/LICENSE https://github.com/v2fly/v2ray-core/tree/v$2" ;;
    *) echo "no licence known for $1" >&2; exit 1 ;;
  esac
}
row() {
  local m; m=$(meta "$1" "$3"); read -r lic licurl srcurl <<< "$m"
  ROWS+=("{\"name\":\"$1\",\"abi\":\"$2\",\"version\":\"$3\",\"source\":\"$4\",\"sha256\":\"$(sha256sum "$5" | cut -d' ' -f1)\",\"license\":\"$lic\",\"licenseUrl\":\"$licurl\",\"sourceUrl\":\"$srcurl\"}")
}

dl() { curl -fsSL --retry 3 -o "$2" "$1"; }

# Hysteria2: hashes.txt lists "<sha256>  build/<asset>"
dl "https://github.com/apernet/hysteria/releases/download/app/v$HY2/hashes.txt" "$WORK/hy2-hashes.txt"
for pair in "x86_64:amd64" "arm64-v8a:arm64"; do
  abi=${pair%%:*}; arch=${pair##*:}; asset=hysteria-android-$arch
  dl "https://github.com/apernet/hysteria/releases/download/app/v$HY2/$asset" "$WORK/$asset"
  want=$(grep -E "[ /]$asset\$" "$WORK/hy2-hashes.txt" | awk '{print $1}')
  got=$(sha256sum "$WORK/$asset" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$want" = "$got" ] || { echo "hysteria2 $asset digest mismatch ($want vs $got)"; exit 1; }
  install -D -m 755 "$WORK/$asset" "$OUT/$abi/libhysteria2.so"
  row hysteria2 "$abi" "$HY2" "release:$asset" "$OUT/$abi/libhysteria2.so"
done

# Xray: zip + .dgst (SHA2-256= line)
for pair in "x86_64:amd64" "arm64-v8a:arm64-v8a"; do
  abi=${pair%%:*}; arch=${pair##*:}; asset=Xray-android-$arch.zip
  dl "https://github.com/XTLS/Xray-core/releases/download/v$XRAY/$asset" "$WORK/$asset"
  dl "https://github.com/XTLS/Xray-core/releases/download/v$XRAY/$asset.dgst" "$WORK/$asset.dgst"
  want=$(grep -i '^SHA2-256=' "$WORK/$asset.dgst" | head -1 | sed 's/.*= *//')
  got=$(sha256sum "$WORK/$asset" | cut -d' ' -f1)
  [ "$want" = "$got" ] || { echo "xray $asset digest mismatch"; exit 1; }
  mkdir -p "$WORK/xray-$abi" && unzip -q -o "$WORK/$asset" -d "$WORK/xray-$abi"
  install -D -m 755 "$WORK/xray-$abi/xray" "$OUT/$abi/libxray.so"
  row xray "$abi" "$XRAY" "release:$asset" "$OUT/$abi/libxray.so"
done

# V2Ray: arm64 official; x86_64 built from the tagged source (no official android-amd64 asset)
asset=v2ray-android-arm64-v8a.zip
dl "https://github.com/v2fly/v2ray-core/releases/download/v$V2RAY/$asset" "$WORK/$asset"
dl "https://github.com/v2fly/v2ray-core/releases/download/v$V2RAY/$asset.dgst" "$WORK/$asset.dgst"
want=$(grep -i '^SHA2-256=' "$WORK/$asset.dgst" | head -1 | sed 's/.*= *//')
got=$(sha256sum "$WORK/$asset" | cut -d' ' -f1)
[ "$want" = "$got" ] || { echo "v2ray $asset digest mismatch"; exit 1; }
mkdir -p "$WORK/v2ray-arm" && unzip -q -o "$WORK/$asset" -d "$WORK/v2ray-arm"
install -D -m 755 "$WORK/v2ray-arm/v2ray" "$OUT/arm64-v8a/libv2ray.so"
row v2ray arm64-v8a "$V2RAY" "release:$asset" "$OUT/arm64-v8a/libv2ray.so"

git clone -q --depth 1 --branch "v$V2RAY" https://github.com/v2fly/v2ray-core "$WORK/v2ray-src"
NDK=${ANDROID_HOME:-/opt/android-sdk}/ndk/27.2.12479018
(cd "$WORK/v2ray-src" && CGO_ENABLED=1 GOOS=android GOARCH=amd64 \
  CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/x86_64-linux-android29-clang" \
  go build -trimpath -ldflags "-s -w -buildid=" -o "$OUT/x86_64/libv2ray.so" ./main)
row v2ray x86_64 "$V2RAY" "source:v2fly/v2ray-core@v$V2RAY GOOS=android GOARCH=amd64" "$OUT/x86_64/libv2ray.so"

{ echo "["; (IFS=$',\n'; echo "${ROWS[*]}"); echo "]"; } | jq . > "$LOCK"
echo "deps ready in $OUT; lock $LOCK"
