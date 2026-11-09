#!/bin/bash
# ─── Build Node.js for Android (runs on test-host) ───
# Usage: bash build-node-android.sh <jniLibs-dir> [abi...]   (default abis: x86_64 arm64-v8a)
# Node 22 LTS from the official source tarball (checked against SHASUMS256.txt, which is
# itself GPG-signed by the release team), cross-built with Node's own android-configure
# script and the NDK. The result is a plain `node` executable shipped as lib<name>.so so
# Android installs it executable in nativeLibraryDir (same pattern as dvpnd).
# Slow: ~40 min per ABI on n2-standard-8.
set -euo pipefail
OUT=${1:?jniLibs dir}
shift
ABIS=("$@")
[ ${#ABIS[@]} -eq 0 ] && ABIS=(x86_64 arm64-v8a)
VER=${NODE_VERSION:-v22.23.4}
API=29
NDK=${ANDROID_HOME:-/opt/android-sdk}/ndk/27.2.12479018
WORK=${WORK:-$HOME/build/node}
mkdir -p "$WORK/dl"
cd "$WORK/dl"

fetch() { [ -f "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"; }
fetch "https://nodejs.org/dist/$VER/node-$VER.tar.xz" "node-$VER.tar.xz"
fetch "https://nodejs.org/dist/$VER/SHASUMS256.txt" SHASUMS256.txt
fetch "https://nodejs.org/dist/$VER/SHASUMS256.txt.sig" SHASUMS256.txt.sig
want=$(grep " node-$VER.tar.xz\$" SHASUMS256.txt | cut -d' ' -f1)
got=$(sha256sum "node-$VER.tar.xz" | cut -d' ' -f1)
[ -n "$want" ] && [ "$want" = "$got" ] || { echo "node tarball digest mismatch"; exit 1; }
echo "node tarball sha256 OK ($got)"

for abi in "${ABIS[@]}"; do
  case $abi in
    x86_64) arch=x86_64 ;;
    arm64-v8a) arch=arm64 ;;
    *) echo "unknown abi $abi"; exit 2 ;;
  esac
  src=$WORK/$abi/node-$VER
  if [ ! -x "$src/out/Release/node" ]; then
    # Resumable: extract + configure once (stamp), then `make` picks up where a failed run stopped.
    if [ ! -f "$WORK/$abi/.configured" ]; then
      rm -rf "$WORK/$abi" && mkdir -p "$WORK/$abi"
      tar -xJf "node-$VER.tar.xz" -C "$WORK/$abi"
      # V8's wasm trap handler: Node's own android-patches/trap-handler.h.patch no longer applies
      # to v22.23.4, and without it the HOST mksnapshot (Linux x64 compiler, V8_TARGET_OS_ANDROID)
      # turns the trap handler on while gyp leaves its posix sources out → undefined
      # TryHandleSignal / RegisterDefaultTrapHandler at link. Android builds: off for target and host.
      th=$src/deps/v8/src/trap-handler/trap-handler.h
      grep -q 'V8_TARGET_OS_ANDROID' "$th" || sed -i 's|^// X64 on Linux, Windows, MacOS, FreeBSD.$|// Android builds (target and host tools): off; gyp leaves the trap-handler sources out.\n#if defined(V8_TARGET_OS_ANDROID)\n#define V8_TRAP_HANDLER_SUPPORTED false\n// X64 on Linux, Windows, MacOS, FreeBSD.|; 0,/^#if V8_HOST_ARCH_X64 \&\& V8_TARGET_ARCH_X64/s//#elif V8_HOST_ARCH_X64 \&\& V8_TARGET_ARCH_X64/' "$th"
      grep -q '^#if defined(V8_TARGET_OS_ANDROID)' "$th" && grep -q '^#elif V8_HOST_ARCH_X64 && V8_TARGET_ARCH_X64' "$th" || { echo "trap-handler.h patch did not apply"; exit 1; }
      # Host tools (torque, mksnapshot, ...) run on this VM: build them with the system compiler,
      # not the NDK one android-configure puts in CC/CXX.
      (cd "$src" && CC_host=gcc CXX_host=g++ LINK_host=g++ AR_host=ar python3 android-configure "$NDK" "$API" "$arch" >"$WORK/$abi/configure.log" 2>&1) ||
        { tail -30 "$WORK/$abi/configure.log"; exit 1; }
      touch "$WORK/$abi/.configured"
    fi
    # zlib on Android ARM asks the NDK cpufeatures library for CRC32/PMULL, which Node's gyp
    # build never links (undefined android_getCpuFeatures on arm64). Answer from the kernel's
    # hwcaps instead (getauxval, API 18+). x86_64 uses cpuid and never reaches this.
    zc=$src/deps/zlib/cpu_features.c
    if ! grep -q 'ddv: android_getCpuFeatures' "$zc"; then
      python3 - "$zc" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
anchor = '#include <cpu-features.h>\n'
assert s.count(anchor) == 1, 'cpu_features.c: include anchor not found once'
shim = anchor + '''#if defined(__aarch64__)
/* ddv: android_getCpuFeatures from the kernel hwcaps; Node links no NDK cpufeatures. */
#include <asm/hwcap.h>
#include <sys/auxv.h>
uint64_t android_getCpuFeatures(void) {
  unsigned long hw = getauxval(AT_HWCAP);
  uint64_t f = 0;
  if (hw & HWCAP_CRC32) f |= ANDROID_CPU_ARM64_FEATURE_CRC32;
  if (hw & HWCAP_PMULL) f |= ANDROID_CPU_ARM64_FEATURE_PMULL;
  return f;
}
#endif
'''
open(p, 'w', encoding='utf-8').write(s.replace(anchor, shim))
PY
      grep -q 'ddv: android_getCpuFeatures' "$zc" || { echo "zlib cpu_features patch did not apply"; exit 1; }
    fi
    (cd "$src" && make -j"$(nproc)" >>"$WORK/$abi/make.log" 2>&1) || { grep -m5 -A3 ' error:\|Error [0-9]' "$WORK/$abi/make.log" | cut -c1-300; exit 1; }
  fi
  install -D -m 755 "$src/out/Release/node" "$OUT/$abi/libnode-bin.so"
  # node links the NDK C++ runtime dynamically; ship it beside it (the app sets LD_LIBRARY_PATH).
  case $abi in x86_64) triple=x86_64-linux-android ;; arm64-v8a) triple=aarch64-linux-android ;; esac
  install -m 644 "$NDK/toolchains/llvm/prebuilt/linux-x86_64/sysroot/usr/lib/$triple/libc++_shared.so" "$OUT/$abi/libc++_shared.so"
  "$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin/llvm-strip" "$OUT/$abi/libnode-bin.so"
  echo "built $OUT/$abi/libnode-bin.so ($(du -h "$OUT/$abi/libnode-bin.so" | cut -f1))"
done
