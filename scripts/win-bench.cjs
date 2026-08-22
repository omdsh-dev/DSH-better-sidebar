// Windows engine benchmark: plain walk vs fd vs rg on the same root/query.
// Usage: node win-bench.cjs <root> [query...]
// PATH is extended with Scoop shims + npm global (ssh sessions lack them).
const { performance } = require('node:perf_hooks')
const os = require('node:os')

const home = os.homedir()
const extra = [
  `${home}\\Scoop\\shims`,
  `${process.env.APPDATA ?? ''}\\npm`,
]
process.env.PATH = [...extra, process.env.PATH ?? ''].filter(Boolean).join(';')

const root = process.argv[2] ?? 'D:\\Project'
const queries = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ['md', 'hollow', '1234', 'test']

;(async () => {
  const { searchFilesPlain, searchFiles } = await import('./src/fs-search.ts')
  console.log(`root=${root} queries=[${queries.join(', ')}] runs=3 best-of`)
  for (const q of queries) {
    const row = {}
    for (const [label, fn] of [
      ['plain', () => searchFilesPlain(root, q)],
      ['fd+rg', () => searchFiles(root, q)],
    ]) {
      const times = []
      let hits = 0, truncated = false
      for (let i = 0; i < 3; i += 1) {
        const t0 = performance.now()
        const r = await fn()
        times.push(performance.now() - t0)
        hits = r.matches.length
        truncated = r.truncated
      }
      row[label] = `${Math.min(...times).toFixed(0)}ms hits=${hits}${truncated ? ' TRUNC' : ''}`
    }
    console.log(`query="${q}"  plain: ${row['plain']}  |  engines: ${row['fd+rg']}`)
  }
})().catch((err) => { console.error('BENCH FAILED:', err); process.exit(1) })