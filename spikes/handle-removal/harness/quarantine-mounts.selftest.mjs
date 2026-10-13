// SMI-6715 Step 1b: the /proc/self/mountinfo parser behind S2b/S9c (design §6).
// Pure functions over a text fixture, so this runs on every platform.
//
// Not red-testable on the pre-repair code (the module did not exist, so the
// import fails -- a setup failure, not the property). Pinned instead by the
// mutation checks recorded in the hand-back: dropping the octal unescape, and
// replacing the at-or-under test with a bare startsWith.

import { parseMountInfo, mountPointsAtOrUnder } from '../quarantine.mounts.mjs'

const TAG = '[quarantine-mounts self-test]'
let allOk = true
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  allOk = allOk && ok
  console.log(
    `${TAG} ${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)} -- ${ok ? 'PASS' : 'FAIL'}`
  )
}

// Field 5 is the mount point. Optional fields (7..) end at ' - '.
const TEXT = [
  '22 1 0:21 / / rw,relatime master:1 - overlay overlay rw',
  '85 22 0:21 /work/src /work/tree/sub rw,relatime shared:1 - overlay overlay rw',
  '99 22 0:45 / /work/tree/tm rw,relatime - tmpfs tmpfs rw',
  '100 22 0:46 / /work/tree/with\\040space rw - tmpfs tmpfs rw',
  '101 22 0:47 / /work/tree/back\\134slash rw - tmpfs tmpfs rw',
  '102 22 0:48 / /work/tree2/sibling rw - tmpfs tmpfs rw',
  '103 22 0:49 / /work/tree rw - tmpfs tmpfs rw',
  '',
].join('\n')

check('M1 every mount point is parsed (field 5)', parseMountInfo(TEXT).length, 7)
check('M2 \\040 unescapes to a space', parseMountInfo(TEXT).includes('/work/tree/with space'), true)
check(
  'M3 \\134 unescapes to a backslash',
  parseMountInfo(TEXT).includes('/work/tree/back\\slash'),
  true
)
check(
  'M4 at-or-under /work/tree: the root itself and entries below it, not a name-prefix sibling',
  mountPointsAtOrUnder('/work/tree', TEXT).sort(),
  [
    '/work/tree',
    '/work/tree/back\\slash',
    '/work/tree/sub',
    '/work/tree/tm',
    '/work/tree/with space',
  ].sort()
)
check('M5 an unrelated directory has none', mountPointsAtOrUnder('/elsewhere', TEXT), [])
check('M6 / matches every mount', mountPointsAtOrUnder('/', TEXT).length, 7)
check('M7 a malformed line is skipped, not thrown on', parseMountInfo('garbage\n\n'), [])

if (!allOk) {
  console.log(`${TAG} SOME CASES FAILED`)
  process.exit(1)
}
console.log(`${TAG} all cases passed`)
