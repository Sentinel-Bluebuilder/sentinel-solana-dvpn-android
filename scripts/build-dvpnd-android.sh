#!/bin/bash
# ─── Build dvpnd for Android (runs on the rig VM, test-host) ───
# Usage: bash scripts/build-dvpnd-android.sh [src-dir] [out-dir]
# Cross-compiles sentinel-dvpnd for android/amd64 (emulator) and android/arm64 (phones) with the
# devnet build identity baked in at link time. Output: <out>/<abi>/libdvpnd.so (an executable named
# like a library so Android extracts it to nativeLibraryDir).
set -euo pipefail
SRC=${1:-$HOME/src/dvpnd}
OUT=${2:-$HOME/out/jniLibs}
NDK=${ANDROID_HOME:-/opt/android-sdk}/ndk/27.2.12479018
API=29

NETWORK=devnet
PROGRAM_ID=J52dyXW3a6mkatvrQct3fo6dA9vqUtcsdBt5gGqrTBXs
MINT=Hen2LVP6KooGaXEvdSyCHWghsEY4gLLn7wix8z6zHFSa
COMMIT=$(cat "$SRC/.commit" 2>/dev/null || echo unknown)
TAG=${TAG:-cf4c372-rc}

# The main package is cmd/sentinel-dvpnd on the cb33 line, cmd/dvpnd on older trees.
CMD=sentinel-dvpnd
[ -d "$SRC/sentinel-dvpnd/cmd/$CMD" ] || CMD=dvpnd

V=github.com/sentinel-official/sentinel-go-sdk/v3/version
LDFLAGS="-s -w -X $V.Network=$NETWORK -X $V.ProgramID=$PROGRAM_ID -X $V.Mint=$MINT -X $V.Commit=$COMMIT -X $V.Tag=$TAG"

build() {
  local goarch=$1 abi=$2 cc=$3
  mkdir -p "$OUT/$abi"
  (cd "$SRC/sentinel-dvpnd" && \
    CGO_ENABLED=1 GOOS=android GOARCH=$goarch \
    CC="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/${cc}${API}-clang" \
    go build -trimpath -ldflags "$LDFLAGS" -o "$OUT/$abi/libdvpnd.so" "./cmd/$CMD")
  echo "built $OUT/$abi/libdvpnd.so ($(du -h "$OUT/$abi/libdvpnd.so" | cut -f1))"
}

build amd64 x86_64 x86_64-linux-android
build arm64 arm64-v8a aarch64-linux-android
