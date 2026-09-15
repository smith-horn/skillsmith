// E47: birthtime granularity and immediate delete/recreate pairs (compared pairwise, not against the first stat).
import fs from 'node:fs'
import path from 'node:path'
const BASE = process.argv[2]
if (!/exp8|^\/tmp\/e47|^\/work/.test(BASE)) throw new Error('unsafe base')
fs.rmSync(BASE, { recursive: true, force: true })
fs.mkdirSync(BASE, { recursive: true })
const fsType = (() => {
  try {
    return fs
      .readFileSync('/proc/mounts', 'utf8')
      .split('\n')
      .map((l) => l.split(' '))
      .filter((p) => p[1] && BASE.startsWith(p[1]))
      .sort((x, y) => y[1].length - x[1].length)[0]?.[2]
  } catch {
    return 'apfs (host)'
  }
})()
// (a) granularity: 500 mkdirs in a tight loop
const births = []
for (let i = 0; i < 500; i++) {
  const d = path.join(BASE, `g${i}`)
  fs.mkdirSync(d)
  births.push(fs.lstatSync(d, { bigint: true }).birthtimeNs)
}
const distinct = new Set(births.map(String)).size
const deltas = []
for (let i = 1; i < births.length; i++)
  if (births[i] !== births[i - 1]) deltas.push(births[i] - births[i - 1])
const minDelta = deltas.length ? deltas.reduce((a, b) => (b < a ? b : a)) : null
const zero = births.filter((b) => b === 0n).length
// (b) immediate pairs: mkdir x, lstat, empty rmdir, mkdir x, lstat; compare the pair
let sameIno = 0,
  sameInoSameBirth = 0,
  sameBirth = 0
for (let i = 0; i < 2000; i++) {
  const d = path.join(BASE, `p${i}`)
  fs.mkdirSync(d)
  const a = fs.lstatSync(d, { bigint: true })
  fs.rmdirSync(d)
  fs.mkdirSync(d)
  const b = fs.lstatSync(d, { bigint: true })
  fs.rmdirSync(d)
  if (a.dev === b.dev && a.ino === b.ino) sameIno++
  if (a.birthtimeNs === b.birthtimeNs) sameBirth++
  if (a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs) sameInoSameBirth++
}
// (c) probe right after root creation: mkdir root, mkdir probe; same birthtime?
let probeSame = 0
for (let i = 0; i < 500; i++) {
  const r = path.join(BASE, `r${i}`)
  const p = path.join(BASE, `r${i}.probe`)
  fs.mkdirSync(r)
  fs.mkdirSync(p)
  if (
    fs.lstatSync(r, { bigint: true }).birthtimeNs === fs.lstatSync(p, { bigint: true }).birthtimeNs
  )
    probeSame++
  fs.rmdirSync(p)
}
fs.rmSync(BASE, { recursive: true, force: true })
console.log(
  JSON.stringify({
    node: process.version,
    fsType,
    granularity: {
      mkdirs: 500,
      zeroBirth: zero,
      distinctBirth: distinct,
      minNonZeroDeltaNs: minDelta?.toString(),
    },
    immediatePairs: { cycles: 2000, sameIno, sameBirth, sameInoSameBirth },
    probeRightAfterRoot: { trials: 500, sameBirth: probeSame },
  })
)
