# SMI-6676 spike results summary

Regenerated from 60 `results/raw/*.jsonl` files, 136240 total records. Do not hand-edit -- run `node results/generate-summary.mjs` after any new attack run.

## Verdict tally

| Verdict | Cells |
|---|---|
| FAIL | 197 |
| NEVER-RAN (control) | 56 |
| NEVER-RAN | 36 |
| PASS (control unverified) | 90 |
| PASS | 227 |

The verdict applies the WHOLE plan §9 rule: `PASS` requires `ran == target`, `never-ran == 0`, `failed == 0` **and** a same-filesystem control cell with `failed >= 1`. `NEVER-RAN (control)` means the candidate itself was clean but the plan's named control never demonstrated the loss on that filesystem, so the fixture proves nothing. `PASS (control unverified)` means the control the plan names is real but lives outside this JSONL (a feasibility script, or a cited earlier experiment) and this harness can neither confirm nor refute it.

## Control status tally

| Control state | Cells |
|---|---|
| ABSENT | 15 |
| DID-NOT-FAIL | 62 |
| external-unverified | 105 |
| is-control | 71 |
| none-by-design | 76 |
| ok | 277 |

## Cells

| Attack | Variant | Candidate | FS | Ran | Passed | Failed | Never-ran | Control | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| A10-C0 | a | C0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | b | C0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | a | C0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | b | C0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | a | C0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | b | C0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | a | C0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | b | C0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | a | C0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-C0 | b | C0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V0 | darwin-apfs | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V1 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V1 | darwin-apfs | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V1 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V2 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V2 | darwin-apfs | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V2 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V0 | ext4vol | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V1 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V1 | ext4vol | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V1 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V2 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V2 | ext4vol | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V2 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V0 | overlayfs | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V1 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V1 | overlayfs | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V1 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V2 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V2 | overlayfs | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V2 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V0 | tmpfsroot | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V1 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V1 | tmpfsroot | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V1 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V2 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V2 | tmpfsroot | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V2 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V0 | virtiofsroot | 30 | 0 | 30 | 0 | external-unverified | FAIL |
| A10-VR | b | V0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V1 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V1 | virtiofsroot | 30 | 10 | 20 | 0 | external-unverified | FAIL |
| A10-VR | b | V1 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/guardHash | V2 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A10-VR | a/none | V2 | virtiofsroot | 30 | 6 | 24 | 0 | external-unverified | FAIL |
| A10-VR | b | V2 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A11 | default | C0 | darwin-apfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V0 | darwin-apfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V1 | darwin-apfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V2 | darwin-apfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | C0 | ext4vol | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V0 | ext4vol | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V1 | ext4vol | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V2 | ext4vol | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | C0 | overlayfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V0 | overlayfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V1 | overlayfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V2 | overlayfs | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | C0 | tmpfsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V0 | tmpfsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V1 | tmpfsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V2 | tmpfsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | C0 | virtiofsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V0 | virtiofsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V1 | virtiofsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A11 | default | V2 | virtiofsroot | 10 | 10 | 0 | 0 | none-by-design | PASS |
| A12 | eacces-unlink | C0 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | C0 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | control-continues-past-errors | darwin-apfs | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | ebusy-rmdir | control-continues-past-errors | darwin-apfs | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | eacces-unlink | V0 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V0 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V1 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V1 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V2 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V2 | darwin-apfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | C0 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | C0 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | control-continues-past-errors | ext4vol | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | ebusy-rmdir | control-continues-past-errors | ext4vol | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | eacces-unlink | V0 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V0 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V1 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V1 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V2 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V2 | ext4vol | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | C0 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | C0 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | control-continues-past-errors | overlayfs | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | ebusy-rmdir | control-continues-past-errors | overlayfs | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | eacces-unlink | V0 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V0 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V1 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V1 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V2 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V2 | overlayfs | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | C0 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | C0 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | control-continues-past-errors | tmpfsroot | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | ebusy-rmdir | control-continues-past-errors | tmpfsroot | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | eacces-unlink | V0 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V0 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V1 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V1 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V2 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V2 | tmpfsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | C0 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | C0 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | control-continues-past-errors | virtiofsroot | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | ebusy-rmdir | control-continues-past-errors | virtiofsroot | 10 | 0 | 10 | 0 | is-control | FAIL |
| A12 | eacces-unlink | V0 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V0 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V1 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V1 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | eacces-unlink | V2 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A12 | ebusy-rmdir | V2 | virtiofsroot | 10 | 10 | 0 | 0 | ok | PASS |
| A13-TIMING | guard-guardHash | V2 | darwin-apfs | 300 | 170 | 0 | 130 | ok | PASS |
| A13-TIMING | guard-none | V2 | darwin-apfs | 300 | 134 | 1 | 165 | ok | FAIL |
| A13-TIMING | guard-guardHash | V2 | ext4vol | 300 | 145 | 0 | 155 | ok | PASS |
| A13-TIMING | guard-none | V2 | ext4vol | 300 | 173 | 30 | 97 | ok | FAIL |
| A13-TIMING | guard-guardHash | V2 | overlayfs | 300 | 156 | 0 | 144 | ok | PASS |
| A13-TIMING | guard-none | V2 | overlayfs | 300 | 185 | 41 | 74 | ok | FAIL |
| A13-TIMING | guard-guardHash | V2 | tmpfsroot | 300 | 145 | 0 | 155 | ok | PASS |
| A13-TIMING | guard-none | V2 | tmpfsroot | 300 | 108 | 64 | 128 | ok | FAIL |
| A13-TIMING | guard-none | V1 | virtiofsroot | 300 | 170 | 127 | 3 | ok | FAIL |
| A13-TIMING | guard-guardHash | V2 | virtiofsroot | 300 | 300 | 0 | 0 | ok | PASS |
| A13-TIMING | guard-none | V2 | virtiofsroot | 300 | 192 | 108 | 0 | ok | FAIL |
| A13-VALIDATE | perEntryTiming-off | V2 | darwin-apfs | 700 | 326 | 66 | 308 | none-by-design | FAIL |
| A13-VALIDATE | perEntryTiming-on | V2 | darwin-apfs | 700 | 315 | 66 | 319 | none-by-design | FAIL |
| A13-WARMARM | arm-A | V2 | darwin-apfs | 4800 | 2430 | 31 | 2339 | none-by-design | FAIL |
| A13-WARMARM | arm-A0 | V2 | darwin-apfs | 4800 | 2438 | 42 | 2320 | none-by-design | FAIL |
| A13-WARMARM | arm-B | V2 | darwin-apfs | 4800 | 2379 | 0 | 2421 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-B0 | V2 | darwin-apfs | 4800 | 2448 | 0 | 2352 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-C | V2 | darwin-apfs | 4800 | 2401 | 25 | 2374 | none-by-design | FAIL |
| A13-WARMARM | arm-P | V2 | darwin-apfs | 4800 | 0 | 0 | 4800 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-A | V2 | ext4vol | 2400 | 757 | 221 | 1422 | none-by-design | FAIL |
| A13-WARMARM | arm-A0 | V2 | ext4vol | 2400 | 753 | 232 | 1415 | none-by-design | FAIL |
| A13-WARMARM | arm-B | V2 | ext4vol | 2400 | 965 | 0 | 1435 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-B0 | V2 | ext4vol | 2400 | 960 | 0 | 1440 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-C | V2 | ext4vol | 2400 | 734 | 199 | 1467 | none-by-design | FAIL |
| A13-WARMARM | arm-P | V2 | ext4vol | 2400 | 0 | 0 | 2400 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-A | V2 | overlayfs | 4800 | 1789 | 489 | 2522 | none-by-design | FAIL |
| A13-WARMARM | arm-A0 | V2 | overlayfs | 4800 | 1706 | 546 | 2548 | none-by-design | FAIL |
| A13-WARMARM | arm-B | V2 | overlayfs | 4800 | 2213 | 0 | 2587 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-B0 | V2 | overlayfs | 4800 | 2209 | 0 | 2591 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-C | V2 | overlayfs | 4800 | 1786 | 457 | 2557 | none-by-design | FAIL |
| A13-WARMARM | arm-P | V2 | overlayfs | 4800 | 0 | 0 | 4800 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-A | V2 | tmpfsroot | 2400 | 661 | 258 | 1481 | none-by-design | FAIL |
| A13-WARMARM | arm-A0 | V2 | tmpfsroot | 2400 | 629 | 236 | 1535 | none-by-design | FAIL |
| A13-WARMARM | arm-B | V2 | tmpfsroot | 2400 | 889 | 0 | 1511 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-B0 | V2 | tmpfsroot | 2400 | 859 | 0 | 1541 | none-by-design | NEVER-RAN |
| A13-WARMARM | arm-C | V2 | tmpfsroot | 2400 | 621 | 208 | 1571 | none-by-design | FAIL |
| A13-WARMARM | arm-P | V2 | tmpfsroot | 2400 | 0 | 0 | 2400 | none-by-design | NEVER-RAN |
| A13 | default | C0 | darwin-apfs | 300 | 98 | 16 | 186 | ok | FAIL |
| A13 | default | V0 | darwin-apfs | 300 | 107 | 9 | 184 | ok | FAIL |
| A13 | default | V1 | darwin-apfs | 300 | 114 | 0 | 186 | ok | PASS |
| A13 | default | V2 | darwin-apfs | 300 | 115 | 0 | 185 | ok | PASS |
| A13 | default | C0 | ext4vol | 300 | 58 | 172 | 70 | ok | FAIL |
| A13 | default | V0 | ext4vol | 300 | 49 | 38 | 213 | ok | FAIL |
| A13 | default | V1 | ext4vol | 300 | 53 | 37 | 210 | ok | FAIL |
| A13 | default | V2 | ext4vol | 300 | 113 | 30 | 157 | ok | FAIL |
| A13 | default | C0 | overlayfs | 300 | 36 | 206 | 58 | ok | FAIL |
| A13 | guardHash | C0 | overlayfs | 300 | 51 | 176 | 73 | ok | FAIL |
| A13 | default | V0 | overlayfs | 300 | 50 | 39 | 211 | ok | FAIL |
| A13 | guardHash | V0 | overlayfs | 300 | 69 | 7 | 224 | ok | FAIL |
| A13 | default | V1 | overlayfs | 300 | 65 | 38 | 197 | ok | FAIL |
| A13 | guardHash | V1 | overlayfs | 300 | 85 | 7 | 208 | ok | FAIL |
| A13 | default | V2 | overlayfs | 300 | 105 | 22 | 173 | ok | FAIL |
| A13 | guardHash | V2 | overlayfs | 300 | 117 | 0 | 183 | ok | PASS |
| A13 | default | C0 | tmpfsroot | 300 | 44 | 178 | 78 | ok | FAIL |
| A13 | default | V0 | tmpfsroot | 300 | 24 | 55 | 221 | ok | FAIL |
| A13 | default | V1 | tmpfsroot | 300 | 51 | 68 | 181 | ok | FAIL |
| A13 | default | V2 | tmpfsroot | 300 | 74 | 73 | 153 | ok | FAIL |
| A13 | default | C0 | virtiofsroot | 300 | 164 | 106 | 30 | ok | FAIL |
| A13 | default | V0 | virtiofsroot | 300 | 185 | 112 | 3 | ok | FAIL |
| A13 | default | V1 | virtiofsroot | 300 | 163 | 137 | 0 | ok | FAIL |
| A13 | default | V2 | virtiofsroot | 300 | 174 | 126 | 0 | ok | FAIL |
| A1 | bind | c0 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A1 | tmpfs | c0 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A1 | bind | v0 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A1 | tmpfs | v0 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A1 | bind | v1 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A1 | tmpfs | v1 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A1 | bind | v2 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A1 | tmpfs | v2 | overlayfs | 10 | 10 | 0 | 0 | external-unverified | PASS (control unverified) |
| A2 | bind | c0 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A2 | tmpfs | c0 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A2 | bind | v0 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A2 | tmpfs | v0 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A2 | bind | v1 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A2 | tmpfs | v1 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A2 | bind | v2 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A2 | tmpfs | v2 | overlayfs | 10 | 10 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A3 | baseline | baseline | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A3 | guardHash | C0 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | C0 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | ud25 | ud25 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | guardHash | V0 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V0 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V1 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V1 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V2 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | baseline | baseline | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A3 | guardHash | C0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | C0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | ud25 | ud25 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | guardHash | V0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V0 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V1 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V1 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V2 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | baseline | baseline | overlayfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A3 | guardHash | C0 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | C0 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | ud25 | ud25 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | guardHash | V0 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V0 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V1 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V1 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V2 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V2 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | baseline | baseline | tmpfsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A3 | guardHash | C0 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | C0 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | ud25 | ud25 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | guardHash | V0 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V0 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V1 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V1 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V2 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V2 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | baseline | baseline | virtiofsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A3 | guardHash | C0 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | C0 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | ud25 | ud25 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | guardHash | V0 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V0 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A3 | guardHash | V1 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V1 | virtiofsroot | 30 | 2 | 28 | 0 | ok | FAIL |
| A3 | guardHash | V2 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A3 | none | V2 | virtiofsroot | 30 | 11 | 19 | 0 | ok | FAIL |
| A4 | baseline | baseline | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A4 | default | C0 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | ud25 | ud25 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V0 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V1 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | baseline | baseline | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A4 | default | C0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | ud25 | ud25 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V1 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | baseline | baseline | overlayfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A4 | default | C0 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | ud25 | ud25 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V0 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V1 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V2 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | baseline | baseline | tmpfsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A4 | default | C0 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | ud25 | ud25 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V0 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V1 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V2 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | baseline | baseline | virtiofsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A4 | default | C0 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | ud25 | ud25 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V0 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V1 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A4 | default | V2 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A5-VR | V0 | V0 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V1 | V1 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V2 | V2 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V0 | V0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A5-VR | V1 | V1 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A5-VR | V2 | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A5-VR | V0 | V0 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A5-VR | V1 | V1 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A5-VR | V2 | V2 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A5-VR | V0 | V0 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A5-VR | V1 | V1 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A5-VR | V2 | V2 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A5-VR | V0 | V0 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V1 | V1 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V2 | V2 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V0 | V0 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V1 | V1 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5-VR | V2 | V2 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A5 | ud24Only | ud24Only | apfs | 300 | 0 | 0 | 300 | is-control | NEVER-RAN |
| A5 | ud25 | ud25 | apfs | 300 | 0 | 0 | 300 | DID-NOT-FAIL | NEVER-RAN |
| A5 | ud24Only | ud24Only | ext4vol | 30 | 11 | 19 | 0 | is-control | FAIL |
| A5 | ud25 | ud25 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A5 | ud24Only | ud24Only | overlayfs | 600 | 360 | 240 | 0 | is-control | FAIL |
| A5 | ud25 | ud25 | overlayfs | 600 | 600 | 0 | 0 | ok | PASS |
| A5 | ud24Only | ud24Only | tmpfsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A5 | ud25 | ud25 | tmpfsroot | 30 | 0 | 0 | 30 | DID-NOT-FAIL | NEVER-RAN |
| A5 | ud24Only | ud24Only | virtiofsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A5 | ud25 | ud25 | virtiofsroot | 30 | 0 | 0 | 30 | DID-NOT-FAIL | NEVER-RAN |
| A6-VR | inner/guardHash | V0 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V0 | apfs | 300 | 0 | 300 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V0 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V0 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V1 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V1 | apfs | 300 | 0 | 300 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V1 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V1 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V2 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V2 | apfs | 300 | 0 | 300 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V2 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V2 | apfs | 300 | 300 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | inner/none | V0 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A6-VR | root/guardHash | V0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | root/none | V0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | inner/guardHash | V1 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | inner/none | V1 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A6-VR | root/guardHash | V1 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | root/none | V1 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | inner/guardHash | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | inner/none | V2 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A6-VR | root/guardHash | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | root/none | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6-VR | inner/guardHash | V0 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | inner/none | V0 | overlayfs-linux-x64-EMULATED | 20 | 0 | 20 | 0 | ABSENT | FAIL |
| A6-VR | root/guardHash | V0 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | root/none | V0 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V1 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | inner/none | V1 | overlayfs-linux-x64-EMULATED | 20 | 0 | 20 | 0 | ABSENT | FAIL |
| A6-VR | root/guardHash | V1 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | root/none | V1 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V2 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | inner/none | V2 | overlayfs-linux-x64-EMULATED | 20 | 0 | 20 | 0 | ABSENT | FAIL |
| A6-VR | root/guardHash | V2 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | root/none | V2 | overlayfs-linux-x64-EMULATED | 20 | 20 | 0 | 0 | ABSENT | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V0 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | inner/none | V0 | overlayfs | 300 | 0 | 300 | 0 | ok | FAIL |
| A6-VR | root/guardHash | V0 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | root/none | V0 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | inner/guardHash | V1 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | inner/none | V1 | overlayfs | 300 | 0 | 300 | 0 | ok | FAIL |
| A6-VR | root/guardHash | V1 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | root/none | V1 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | inner/guardHash | V2 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | inner/none | V2 | overlayfs | 300 | 0 | 300 | 0 | ok | FAIL |
| A6-VR | root/guardHash | V2 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | root/none | V2 | overlayfs | 300 | 300 | 0 | 0 | ok | PASS |
| A6-VR | inner/guardHash | V0 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V0 | tmpfsroot | 30 | 0 | 30 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V0 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V0 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V1 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V1 | tmpfsroot | 30 | 0 | 30 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V1 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V1 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V2 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V2 | tmpfsroot | 30 | 0 | 30 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V2 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V2 | tmpfsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V0 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V0 | virtiofsroot | 30 | 0 | 30 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V0 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V0 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V1 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V1 | virtiofsroot | 30 | 7 | 23 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V1 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V1 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/guardHash | V2 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | inner/none | V2 | virtiofsroot | 30 | 10 | 20 | 0 | DID-NOT-FAIL | FAIL |
| A6-VR | root/guardHash | V2 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6-VR | root/none | V2 | virtiofsroot | 30 | 30 | 0 | 0 | DID-NOT-FAIL | NEVER-RAN (control) |
| A6 | inner | ud24Only | apfs | 300 | 0 | 0 | 300 | is-control | NEVER-RAN |
| A6 | root | ud24Only | apfs | 300 | 0 | 0 | 300 | is-control | NEVER-RAN |
| A6 | inner | ud25 | apfs | 300 | 0 | 0 | 300 | DID-NOT-FAIL | NEVER-RAN |
| A6 | root | ud25 | apfs | 300 | 0 | 0 | 300 | DID-NOT-FAIL | NEVER-RAN |
| A6 | inner | ud25WalkStart | apfs | 300 | 0 | 0 | 300 | is-control | NEVER-RAN |
| A6 | root | ud25WalkStart | apfs | 300 | 0 | 0 | 300 | is-control | NEVER-RAN |
| A6 | inner | ud24Only | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A6 | root | ud24Only | ext4vol | 30 | 6 | 24 | 0 | is-control | FAIL |
| A6 | inner | ud25 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6 | root | ud25 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A6 | inner | ud25WalkStart | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A6 | root | ud25WalkStart | ext4vol | 30 | 8 | 22 | 0 | is-control | FAIL |
| A6 | inner | ud24Only | overlayfs | 600 | 0 | 600 | 0 | is-control | FAIL |
| A6 | root | ud24Only | overlayfs | 600 | 203 | 397 | 0 | is-control | FAIL |
| A6 | inner | ud25 | overlayfs | 600 | 600 | 0 | 0 | ok | PASS |
| A6 | root | ud25 | overlayfs | 600 | 600 | 0 | 0 | ok | PASS |
| A6 | inner | ud25WalkStart | overlayfs | 600 | 0 | 600 | 0 | is-control | FAIL |
| A6 | root | ud25WalkStart | overlayfs | 600 | 186 | 414 | 0 | is-control | FAIL |
| A6 | inner | ud24Only | tmpfsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A6 | root | ud24Only | tmpfsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A6 | inner | ud25 | tmpfsroot | 30 | 0 | 0 | 30 | DID-NOT-FAIL | NEVER-RAN |
| A6 | root | ud25 | tmpfsroot | 30 | 0 | 0 | 30 | DID-NOT-FAIL | NEVER-RAN |
| A6 | inner | ud25WalkStart | tmpfsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A6 | root | ud25WalkStart | tmpfsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A6 | inner | ud24Only | virtiofsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A6 | root | ud24Only | virtiofsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A6 | inner | ud25 | virtiofsroot | 30 | 0 | 0 | 30 | DID-NOT-FAIL | NEVER-RAN |
| A6 | root | ud25 | virtiofsroot | 30 | 0 | 0 | 30 | DID-NOT-FAIL | NEVER-RAN |
| A6 | inner | ud25WalkStart | virtiofsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A6 | root | ud25WalkStart | virtiofsroot | 30 | 0 | 0 | 30 | is-control | NEVER-RAN |
| A7 | before-unlink/file | C0 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | C0 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | C0 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/symlink | C0 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/file | V0 | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/symlink | V0 | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/file | V0 | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/symlink | V0 | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/file | V1 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | V1 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | V1 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V1 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/file | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/symlink | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/file | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/file | C0 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | C0 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | C0 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/symlink | C0 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/file | V0 | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/symlink | V0 | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/file | V0 | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/symlink | V0 | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/file | V1 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | V1 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | V1 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/symlink | V1 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/file | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/symlink | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/file | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/file | C0 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | C0 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | C0 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/symlink | C0 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/file | V0 | overlayfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/symlink | V0 | overlayfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/file | V0 | overlayfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/symlink | V0 | overlayfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/file | V1 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | V1 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | V1 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/symlink | V1 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/file | V2 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/symlink | V2 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/file | V2 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V2 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/file | C0 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | C0 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | C0 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/symlink | C0 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/file | V0 | tmpfsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/symlink | V0 | tmpfsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/file | V0 | tmpfsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/symlink | V0 | tmpfsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/file | V1 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | V1 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | V1 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V1 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/file | V2 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/symlink | V2 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/file | V2 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V2 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/file | C0 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | C0 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | C0 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/symlink | C0 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/file | V0 | virtiofsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/symlink | V0 | virtiofsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/file | V0 | virtiofsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | between/symlink | V0 | virtiofsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A7 | before-unlink/file | V1 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | before-unlink/symlink | V1 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A7 | between/file | V1 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V1 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/file | V2 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | before-unlink/symlink | V2 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/file | V2 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A7 | between/symlink | V2 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A8 | a | C0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | C0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V0 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V1 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V1 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V2 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V2 | darwin-apfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | C0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | C0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V0 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V1 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V1 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V2 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V2 | ext4vol | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | C0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | C0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V0 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V1 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V1 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V2 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V2 | overlayfs | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | C0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | C0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V0 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V1 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V1 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V2 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V2 | tmpfsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | C0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | C0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V0 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V1 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V1 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | a | V2 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A8 | b | V2 | virtiofsroot | 30 | 30 | 0 | 0 | external-unverified | PASS (control unverified) |
| A9-C0 | apfs-setfile | C0 | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A9-C0 | stub | C0 | darwin-apfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A9-C0 | stub | C0 | ext4vol | 30 | 0 | 30 | 0 | is-control | FAIL |
| A9-C0 | stub | C0 | overlayfs | 30 | 0 | 30 | 0 | is-control | FAIL |
| A9-C0 | stub | C0 | tmpfsroot | 30 | 0 | 30 | 0 | is-control | FAIL |
| A9-C0 | stub | C0 | virtiofsroot | 30 | 1 | 29 | 0 | is-control | FAIL |
| A9-VR | apfs-setfile/guardHash | V0 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | apfs-setfile/none | V0 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V0 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V0 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | apfs-setfile/guardHash | V1 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | apfs-setfile/none | V1 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V1 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V1 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | apfs-setfile/guardHash | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | apfs-setfile/none | V2 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V2 | darwin-apfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V2 | darwin-apfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V0 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V0 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V1 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V1 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V2 | ext4vol | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V2 | ext4vol | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V0 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V0 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V1 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V1 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V2 | overlayfs | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V2 | overlayfs | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V0 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V0 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V1 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V1 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V2 | tmpfsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V2 | tmpfsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V0 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V0 | virtiofsroot | 30 | 0 | 30 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V1 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V1 | virtiofsroot | 30 | 3 | 27 | 0 | ok | FAIL |
| A9-VR | stub/guardHash | V2 | virtiofsroot | 30 | 30 | 0 | 0 | ok | PASS |
| A9-VR | stub/none | V2 | virtiofsroot | 30 | 7 | 23 | 0 | ok | FAIL |
| N1-VR | guardHash | V0 | darwin-apfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V0 | darwin-apfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V1 | darwin-apfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V1 | darwin-apfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V2 | darwin-apfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V2 | darwin-apfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V0 | ext4vol | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V0 | ext4vol | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V1 | ext4vol | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V1 | ext4vol | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V2 | ext4vol | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V2 | ext4vol | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V0 | overlayfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V0 | overlayfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V1 | overlayfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V1 | overlayfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V2 | overlayfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V2 | overlayfs | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V0 | tmpfsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V0 | tmpfsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V1 | tmpfsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V1 | tmpfsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V2 | tmpfsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V2 | tmpfsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V0 | virtiofsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V0 | virtiofsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V1 | virtiofsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V1 | virtiofsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | guardHash | V2 | virtiofsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1-VR | none | V2 | virtiofsroot | 300 | 300 | 0 | 0 | none-by-design | PASS |
| N1 | ud25 | ud25 | apfs | 300 | 300 | 0 | 0 | external-unverified | PASS (control unverified) |
| N1 | ud25 | ud25 | overlayfs | 300 | 300 | 0 | 0 | external-unverified | PASS (control unverified) |

Total: 606 cells, 136240 runs.

## Cells whose control did not bite

| Attack | Variant | Candidate | FS | Control state | Why |
|---|---|---|---|---|---|
| A2 | bind | c0 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A2 | tmpfs | c0 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A2 | bind | v0 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A2 | tmpfs | v0 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A2 | bind | v1 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A2 | tmpfs | v1 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A2 | bind | v2 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A2 | tmpfs | v2 | overlayfs | DID-NOT-FAIL | plan §5.1 A2 -- A2/c0 on overlayfs recorded 0 failures |
| A5-VR | V0 | V0 | apfs | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on apfs recorded 0 failures |
| A5-VR | V1 | V1 | apfs | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on apfs recorded 0 failures |
| A5-VR | V2 | V2 | apfs | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on apfs recorded 0 failures |
| A5-VR | V0 | V0 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A5: 'C0 without the gate' -- no A5/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A5-VR | V1 | V1 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A5: 'C0 without the gate' -- no A5/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A5-VR | V2 | V2 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A5: 'C0 without the gate' -- no A5/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A5-VR | V0 | V0 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on tmpfsroot recorded 0 failures |
| A5-VR | V1 | V1 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on tmpfsroot recorded 0 failures |
| A5-VR | V2 | V2 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on tmpfsroot recorded 0 failures |
| A5-VR | V0 | V0 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on virtiofsroot recorded 0 failures |
| A5-VR | V1 | V1 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on virtiofsroot recorded 0 failures |
| A5-VR | V2 | V2 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on virtiofsroot recorded 0 failures |
| A5 | ud25 | ud25 | apfs | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on apfs recorded 0 failures |
| A5 | ud25 | ud25 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on tmpfsroot recorded 0 failures |
| A5 | ud25 | ud25 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A5: 'C0 without the gate' -- A5/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | inner/guardHash | V0 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | inner/none | V0 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | root/guardHash | V0 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | root/none | V0 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | inner/guardHash | V1 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | inner/none | V1 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | root/guardHash | V1 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | root/none | V1 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | inner/guardHash | V2 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | inner/none | V2 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | root/guardHash | V2 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | root/none | V2 | apfs | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on apfs recorded 0 failures |
| A6-VR | inner/guardHash | V0 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | inner/none | V0 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | root/guardHash | V0 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | root/none | V0 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | inner/guardHash | V1 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | inner/none | V1 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | root/guardHash | V1 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | root/none | V1 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | inner/guardHash | V2 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | inner/none | V2 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | root/guardHash | V2 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | root/none | V2 | overlayfs-linux-x64-EMULATED | ABSENT | plan §5.1 A6 -- no A6/ud24Only cell exists on overlayfs-linux-x64-EMULATED |
| A6-VR | inner/guardHash | V0 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | inner/none | V0 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | root/guardHash | V0 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | root/none | V0 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | inner/guardHash | V1 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | inner/none | V1 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | root/guardHash | V1 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | root/none | V1 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | inner/guardHash | V2 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | inner/none | V2 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | root/guardHash | V2 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | root/none | V2 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6-VR | inner/guardHash | V0 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | inner/none | V0 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | root/guardHash | V0 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | root/none | V0 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | inner/guardHash | V1 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | inner/none | V1 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | root/guardHash | V1 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | root/none | V1 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | inner/guardHash | V2 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | inner/none | V2 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | root/guardHash | V2 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6-VR | root/none | V2 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6 -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6 | inner | ud25 | apfs | DID-NOT-FAIL | plan §5.1 A6: 'C0 with the gate at walk start' -- A6/ud24Only on apfs recorded 0 failures |
| A6 | root | ud25 | apfs | DID-NOT-FAIL | plan §5.1 A6: 'C0 with the gate at walk start' -- A6/ud24Only on apfs recorded 0 failures |
| A6 | inner | ud25 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6: 'C0 with the gate at walk start' -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6 | root | ud25 | tmpfsroot | DID-NOT-FAIL | plan §5.1 A6: 'C0 with the gate at walk start' -- A6/ud24Only on tmpfsroot recorded 0 failures |
| A6 | inner | ud25 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6: 'C0 with the gate at walk start' -- A6/ud24Only on virtiofsroot recorded 0 failures |
| A6 | root | ud25 | virtiofsroot | DID-NOT-FAIL | plan §5.1 A6: 'C0 with the gate at walk start' -- A6/ud24Only on virtiofsroot recorded 0 failures |

