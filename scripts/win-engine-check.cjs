// This is an ops script run directly with `node <file>` on a real host (not
// bundled by tsdown): CommonJS require() is intentional here.
/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync } = require('node:child_process')
const root = 'C:\\Users\\y\\wintest'
function run(label, binary, args) {
  try {
    const out = execFileSync(binary, args, { cwd: root, encoding: 'buffer' })
    const hasBackslash = out.includes(92)
    const hasCR = out.includes(13)
    const hasLF = out.includes(10)
    console.log(`=== ${label} (${binary}) ===`)
    console.log('backslash:', hasBackslash, '| CR:', hasCR, '| LF:', hasLF)
    console.log('raw:', JSON.stringify(out.toString('utf8')))
  } catch (err) {
    console.log(`=== ${label} (${binary}) FAILED ===`)
    console.log(String(err.stderr ?? err.message))
  }
}
run('rg default (no path-separator)', 'rg', ['--files', '--hidden', '--no-ignore', '.'])
run('rg with --path-separator /', 'rg', ['--files', '--hidden', '--no-ignore', '--path-separator', '/', '.'])
run('fd default (no path-separator)', 'fd', ['--hidden', '--no-ignore', '--fixed-strings', '--ignore-case', 'a', '.'])
run('fd with --path-separator /', 'fd', ['--hidden', '--no-ignore', '--fixed-strings', '--ignore-case', '--path-separator', '/', 'a', '.'])