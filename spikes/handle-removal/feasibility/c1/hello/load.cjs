const t0 = process.hrtime.bigint(); const m = require('./build/Release/hello.node'); const t1 = process.hrtime.bigint()
const d = __dirname + '/fx'
console.log(JSON.stringify({ node: process.version, napi: process.versions.napi, modules: process.versions.modules, hello: m.hello(), requireMs: Number(t1 - t0) / 1e6,
  openatRegularDir: m.probeOpenat(d, 'd'), openatSymlinkNoFollow: m.probeOpenat(d, 'ldir'), openSymlinkAsDirfd: m.probeOpenat(d + '/ldir', 'f') }))
