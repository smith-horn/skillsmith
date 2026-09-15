import fs from 'node:fs'
import path from 'node:path'
const bases = process.argv.slice(2)
for (const base of bases) {
  try {
    const d = fs.mkdtempSync(path.join(base, 'e45-'))
    const a = path.join(d, 'x')
    fs.mkdirSync(a)
    const s1 = fs.lstatSync(a, { bigint: true })
    // inode reuse probe: remove and recreate many times, look for same ino with same birthtime
    let sameIno = 0,
      sameInoSameBirth = 0
    for (let i = 0; i < 2000; i++) {
      fs.rmdirSync(a)
      fs.mkdirSync(a)
      const s2 = fs.lstatSync(a, { bigint: true })
      if (s2.ino === s1.ino && s2.dev === s1.dev) {
        sameIno++
        if (s2.birthtimeNs === s1.birthtimeNs) sameInoSameBirth++
      }
    }
    const fsType = (() => {
      try {
        return fs
          .readFileSync('/proc/mounts', 'utf8')
          .split('\n')
          .map((l) => l.split(' '))
          .filter((p) => base.startsWith(p[1]))
          .sort((x, y) => y[1].length - x[1].length)[0]?.[2]
      } catch {
        return 'n/a'
      }
    })()
    console.log(
      JSON.stringify({
        base,
        fsType,
        birthtimeNs: s1.birthtimeNs.toString(),
        birthZero: s1.birthtimeNs === 0n,
        inoReuseOf2000: sameIno,
        inoReuseSameBirth: sameInoSameBirth,
      })
    )
    fs.rmSync(d, { recursive: true, force: true })
  } catch (e) {
    console.log(JSON.stringify({ base, error: e.code || String(e) }))
  }
}
