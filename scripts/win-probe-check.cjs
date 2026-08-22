// Windows real-machine probe verification: does bundledRgCandidates hit
// the DSH global install's ripgrep, and does probeEngines actually pick it?
const { existsSync } = require('node:fs')
const { homedir } = require('node:os')
;(async () => {
  const m = await import('./src/search-engines.ts')
  console.log('platform:', process.platform, 'arch:', process.arch)
  console.log('APPDATA:', process.env.APPDATA ?? '(unset)')
  const paths = m.bundledRgCandidates(process.platform, process.arch, process.execPath, process.env, homedir())
  for (const p of paths) console.log(existsSync(p) ? 'EXISTS ' : '  -    ', p)
  console.log('--- probeEngines (real spawn --version check) ---')
  const probes = await m.probeEngines()
  console.log('probed engines:', JSON.stringify(probes, null, 2))
})().catch((err) => { console.error('FAILED:', err); process.exit(1) })