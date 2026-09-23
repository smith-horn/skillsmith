#!/usr/bin/env node
// Independent recomputation of the embedding for ADR-170 § 2 arm 3.
//
// "performed in its own process from the manifested model file (by recorded
// sha256) and the manifested tokenizer". This process never talks to the MCP
// server: it loads the four manifested cache files directly, verifies their
// sha256 against the digests ADR-170 § 2 records, and runs the feature
// extraction itself with pooling mean + normalize true.
//
// Two vantage points, both used by the driver, because they answer different
// questions:
//   --where container  the ruflo image's own @huggingface/transformers and its
//                      own cache, network none, separate container. Same
//                      library as the server, so byte equality is the
//                      expectation; this is the arm's primary evidence.
//   --where host       this repo's @huggingface/transformers (a different
//                      version) on macOS, against the same manifested files
//                      copied out by digest. A cross-implementation check; the
//                      determinism clause's max-abs-diff applies to it.
//
// Usage:
//   node recompute.mjs --where container|host --transformers <dir> \
//        --cache <dir> --out <json> --text <t> [--text <t>...]

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// The digests ADR-170 § 2 publishes for the one cache the served chain reads.
const EXPECTED = {
  'onnx/model.onnx': '759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e',
  'config.json': '7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7',
  'tokenizer.json': 'da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0',
  'tokenizer_config.json': '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3',
}
const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'

const opt = { where: 'container', transformers: null, cache: null, out: null, texts: [] }
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--where') opt.where = argv[(i += 1)]
  else if (argv[i] === '--transformers') opt.transformers = argv[(i += 1)]
  else if (argv[i] === '--cache') opt.cache = argv[(i += 1)]
  else if (argv[i] === '--out') opt.out = argv[(i += 1)]
  else if (argv[i] === '--text') opt.texts.push(argv[(i += 1)])
  else throw new Error(`unknown argument: ${argv[i]}`)
}

const ev = {
  where: opt.where,
  cache: opt.cache,
  digests: {},
  digestsOk: true,
  vectors: {},
  pid: process.pid,
}

for (const [rel, want] of Object.entries(EXPECTED)) {
  const p = path.join(opt.cache, MODEL_ID, rel)
  let got = null
  try {
    got = createHash('sha256').update(readFileSync(p)).digest('hex')
  } catch (e) {
    got = `ERR:${e.code ?? e.message}`
  }
  ev.digests[rel] = { expected: want, actual: got, match: got === want }
  if (got !== want) ev.digestsOk = false
}

if (!ev.digestsOk) {
  writeFileSync(opt.out, `${JSON.stringify(ev, null, 2)}\n`)
  process.stderr.write('recompute: manifested cache digest mismatch -- refusing to recompute\n')
  process.exit(2)
}

const entry = path.join(opt.transformers, 'dist', 'transformers.node.mjs')
const { pipeline, env } = await import(entry)
env.allowRemoteModels = false
env.allowLocalModels = true
env.cacheDir = opt.cache
env.localModelPath = opt.cache
ev.transformersVersion = JSON.parse(
  readFileSync(path.join(opt.transformers, 'package.json'), 'utf8')
).version

// dtype fp32 selects onnx/model.onnx. The default would take
// model_quantized.onnx, which is not in the manifested cache at all -- ADR-170
// § 2 records "No model_quantized.onnx" as measured.
const extract = await pipeline('feature-extraction', MODEL_ID, { dtype: 'fp32' })
for (const text of opt.texts) {
  const out = await extract(text, { pooling: 'mean', normalize: true })
  ev.vectors[text] = Array.from(out.data)
}

writeFileSync(opt.out, `${JSON.stringify(ev, null, 2)}\n`)
process.stdout.write(
  `recompute where=${opt.where} transformers=${ev.transformersVersion} texts=${opt.texts.length} digests=ok\n`
)
