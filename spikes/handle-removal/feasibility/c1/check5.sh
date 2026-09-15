#!/bin/bash
set -u
[ -f /.dockerenv ] || { echo "refusing: not in a container"; exit 99; }
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq gcc libc6-dev linux-libc-dev >/dev/null 2>&1; echo "apt rc=$?"
gcc -O2 -o /mp /c1/mountprobe.c; echo "gcc rc=$? kernel=$(uname -r) glibc=$(ldd --version | head -1 | awk '{print $NF}')"
for root in /work /tmpfsroot; do
  mkdir -p $root; [ $root = /tmpfsroot ] && mount -t tmpfs tmpfs $root
  W=$root/p; mkdir -p $W/t/plain $W/t/bind $W/t/tmp $W/user; echo U > $W/user/u.txt
  mount --bind $W/user $W/t/bind; mount -t tmpfs tmpfs $W/t/tmp; ln -s $W/user $W/t/link
  echo "root fs=$(stat -f -c %T $root)"
  /mp probe plain-dir $W/t plain; /mp probe same-fs-bind-mount $W/t bind; /mp probe tmpfs-mount $W/t tmp; /mp probe symlink-to-dir $W/t link
  mkdir -p $W/t2/sub; echo UNDER > $W/t2/sub/u.txt; mkdir -p $W/user2; echo USER > $W/user2/u.txt
  ( /mp pin $W/t2 sub ) & pid=$!; sleep 1; mount --bind $W/user2 $W/t2/sub; wait $pid
  echo "  after pin: mounted user2/u.txt survives=$([ -f $W/user2/u.txt ] && echo yes || echo no); underlying u.txt visible after umount=$(umount $W/t2/sub; [ -f $W/t2/sub/u.txt ] && echo yes || echo no-deleted-through-fd)"
  mkdir -p $W/r; echo a > $W/r/a; echo b > $W/r/b; /mp rename $W/r a b; echo "  b content=$(cat $W/r/b)"
done
