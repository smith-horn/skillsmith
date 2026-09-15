#!/bin/bash
# SMI-6676 check 3 (Linux, throwaway node:22-slim): C N-API via node-gyp, and Rust napi-rs, hello-world only.
set -u
[ -f /.dockerenv ] || { echo "refusing: not in a container"; exit 99; }
export DEBIAN_FRONTEND=noninteractive
t0=$(date +%s); apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq build-essential python3 curl ca-certificates >/dev/null 2>&1; echo "apt rc=$? secs=$(( $(date +%s)-t0 ))"
echo "node $(node -v) napi=$(node -p process.versions.napi) gcc=$(gcc -dumpfullversion) make=$(make -v | head -1) python=$(python3 --version) glibc=$(ldd --version | head -1) arch=$(uname -m)"
mkdir -p /build && cp -r /c1/hello /build/c && cd /build/c && rm -rf build node_modules
t0=$(date +%s); npx --yes node-gyp@13.0.2 rebuild > /build/c.log 2>&1; rc=$?; echo "C node-gyp rebuild rc=$rc secs=$(( $(date +%s)-t0 ))"; tail -2 /build/c.log
ls -l build/Release/hello.node; echo "C max GLIBC symbol: $(objdump -T build/Release/hello.node | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
node -e 'const t0=process.hrtime.bigint();const m=require("./build/Release/hello.node");console.log(JSON.stringify({hello:m.hello(),requireMs:Number(process.hrtime.bigint()-t0)/1e6}))'; echo "load rc=$?"
t0=$(date +%s); curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable > /build/rustup.log 2>&1; echo "rustup rc=$? secs=$(( $(date +%s)-t0 ))"
. "$HOME/.cargo/env"; echo "$(cargo --version) / $(rustc --version)"
cp -r /c2/napi-hello /build/r && cd /build/r && rm -rf target
t0=$(date +%s); cargo build --release > /build/r.log 2>&1; rc=$?; echo "napi-rs cargo build rc=$rc secs=$(( $(date +%s)-t0 ))"; tail -3 /build/r.log
grep -E '^name = "(napi|napi-derive|napi-build|napi-sys)"' -A1 Cargo.lock | paste - - - | tr -s ' '
cp target/release/libs6676_napi_hello.so hello-rs.node && ls -l hello-rs.node && echo "Rust max GLIBC symbol: $(objdump -T hello-rs.node | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1)"
node -e 'const t0=process.hrtime.bigint();const m=require("./hello-rs.node");console.log(JSON.stringify({hello:m.hello(),requireMs:Number(process.hrtime.bigint()-t0)/1e6}))'; echo "load rc=$?"
