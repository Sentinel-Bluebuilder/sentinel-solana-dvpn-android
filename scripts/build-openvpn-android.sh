#!/bin/bash
# ─── Build OpenVPN for Android (runs on test-host) ───
# Usage: bash build-openvpn-android.sh <jniLibs-dir>
# OpenVPN 2.6.23 (same version as the Windows app) configured for *-linux-android, which turns on
# TARGET_ANDROID: OpenVPN never touches interfaces/routes itself, it asks over its management
# unix socket (IFCONFIG/ROUTE/DNSSERVER/OPENTUN) and dvpnd answers with the VpnService fd.
# OpenSSL 3.5 LTS linked statically. Writes <abi>/libovpnexec.so for x86_64 and arm64-v8a.
# The node pushes no compression, so lzo/lz4 are left out.
set -euo pipefail
OUT=${1:?jniLibs dir}
OVPN=2.6.23
OSSL=3.5.9
API=29
NDK=${ANDROID_HOME:-/opt/android-sdk}/ndk/27.2.12479018
TC=$NDK/toolchains/llvm/prebuilt/linux-x86_64
WORK=${WORK:-$HOME/build/openvpn}
mkdir -p "$WORK/dl"
cd "$WORK/dl"

fetch() { [ -f "$2" ] || curl -fsSL --retry 3 -o "$2" "$1"; }
fetch "https://github.com/openssl/openssl/releases/download/openssl-$OSSL/openssl-$OSSL.tar.gz" "openssl-$OSSL.tar.gz"
fetch "https://github.com/openssl/openssl/releases/download/openssl-$OSSL/openssl-$OSSL.tar.gz.sha256" "openssl-$OSSL.tar.gz.sha256"
want=$(awk '{print $1}' "openssl-$OSSL.tar.gz.sha256")
got=$(sha256sum "openssl-$OSSL.tar.gz" | cut -d' ' -f1)
[ "$want" = "$got" ] || { echo "openssl digest mismatch"; exit 1; }

fetch "https://swupdate.openvpn.net/community/releases/openvpn-$OVPN.tar.gz" "openvpn-$OVPN.tar.gz"
fetch "https://swupdate.openvpn.net/community/releases/openvpn-$OVPN.tar.gz.asc" "openvpn-$OVPN.tar.gz.asc"
# Signature check: OpenVPN security mailing list key (F554A3687412CFFEBDEFE0A312F5F7B42F2B01E7).
if command -v gpg >/dev/null; then
  export GNUPGHOME=$WORK/gnupg
  mkdir -p "$GNUPGHOME" && chmod 700 "$GNUPGHOME"
  gpg -q --keyserver hkps://keys.openpgp.org --recv-keys F554A3687412CFFEBDEFE0A312F5F7B42F2B01E7 2>/dev/null ||
    gpg -q --keyserver hkps://keyserver.ubuntu.com --recv-keys F554A3687412CFFEBDEFE0A312F5F7B42F2B01E7
  gpg -q --verify "openvpn-$OVPN.tar.gz.asc" "openvpn-$OVPN.tar.gz"
  echo "openvpn signature OK"
fi

# Upstream autotools/CMake have no Android target (ics-openvpn defines it in its own build).
# Configure as Linux (libcap-ng stubbed), then turn the Linux target into the Android one.
# TARGET_LINUX must be gone: some #if chains test it before TARGET_ANDROID.
android_config() {
  sed -i -e 's/^#define TARGET_LINUX 1$/#define TARGET_ANDROID 1/' \
    -e '/^#define HAVE_LIBCAPNG 1$/d' -e '/^#define ENABLE_SITNL 1$/d' \
    -e '/^#define ENABLE_FEATURE_TUN_PERSIST 1$/d' "$1"
  grep -q '^#define TARGET_ANDROID 1$' "$1" && ! grep -qE '^#define (TARGET_LINUX|HAVE_LIBCAPNG|ENABLE_SITNL|ENABLE_FEATURE_TUN_PERSIST) ' "$1"
}

for pair in "x86_64:x86_64:android-x86_64" "arm64-v8a:aarch64:android-arm64"; do
  IFS=: read -r abi triple osslTarget <<<"$pair"
  host=$triple-linux-android
  prefix=$WORK/$abi/prefix
  export PATH=$TC/bin:$PATH
  export ANDROID_NDK_ROOT=$NDK

  if [ ! -f "$prefix/lib/libssl.a" ]; then
    rm -rf "$WORK/$abi/openssl" && mkdir -p "$WORK/$abi/openssl"
    tar -xzf "$WORK/dl/openssl-$OSSL.tar.gz" -C "$WORK/$abi/openssl" --strip-components=1
    (cd "$WORK/$abi/openssl" &&
      ./Configure "$osslTarget" -D__ANDROID_API__=$API no-shared no-tests no-apps no-docs no-engine \
        --prefix="$prefix" --libdir=lib >/dev/null &&
      make -j"$(nproc)" >/dev/null && make install_sw >/dev/null)
  fi

  rm -rf "$WORK/$abi/openvpn" && mkdir -p "$WORK/$abi/openvpn"
  tar -xzf "$WORK/dl/openvpn-$OVPN.tar.gz" -C "$WORK/$abi/openvpn" --strip-components=1
  (cd "$WORK/$abi/openvpn" &&
    CC=$TC/bin/$host$API-clang \
    OPENSSL_CFLAGS="-I$prefix/include" OPENSSL_LIBS="-L$prefix/lib -lssl -lcrypto" \
    LIBCAPNG_CFLAGS=" " LIBCAPNG_LIBS=" " \
    ./configure --host="$host" --with-crypto-library=openssl \
      --disable-lzo --disable-lz4 --disable-plugins --disable-dco --disable-unit-tests \
      --disable-plugin-auth-pam --disable-plugin-down-root --enable-management >/dev/null &&
    android_config config.h &&
    make -j"$(nproc)" >/dev/null)
  install -D -m 755 "$WORK/$abi/openvpn/src/openvpn/openvpn" "$OUT/$abi/libovpnexec.so"
  "$TC/bin/llvm-strip" "$OUT/$abi/libovpnexec.so"
  echo "built $OUT/$abi/libovpnexec.so ($(du -h "$OUT/$abi/libovpnexec.so" | cut -f1)) sha256 $(sha256sum "$OUT/$abi/libovpnexec.so" | cut -c1-16)"
done
