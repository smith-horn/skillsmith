const rows = require('fs')
  .readFileSync(process.argv[2], 'utf8')
  .trim()
  .split('\n')
  .map((l) => {
    try {
      return JSON.parse(l)
    } catch {
      return { raw: l }
    }
  })
const agg = {}
for (const r of rows) {
  if (r.raw) {
    console.log('RAW', r.raw)
    continue
  }
  if (r.runs) {
    console.log(JSON.stringify(r))
    continue
  }
  const k = [
    r.path,
    r.walk || '',
    r.result,
    'survives=' + (r.userFileSurvives ?? r.fileInsideSubSurvives),
    'check=' + r.checkPassed,
    'mounted=' + r.mountActive,
    'left=' + (r.entriesLeft || []).join(','),
  ].join(' | ')
  agg[k] = (agg[k] || 0) + 1
}
for (const [k, v] of Object.entries(agg)) console.log(v + 'x ' + k)
