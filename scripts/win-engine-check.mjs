/**
 * Engine output-shape gate for the fd / ripgrep binaries behind fs.search's
 * file-name search. `node scripts/win-engine-check.mjs` prints what each
 * installed engine emits (human inspection); `--assert` turns it into the
 * CI gate the ci-windows lane runs after `choco install fd ripgrep`.
 *
 * The assertions cover exactly what the plugin's own argvs promise:
 *
 * - `--path-separator /` output carries no '\' and no CR — on Windows rg
 *   emits '\' paths in cmd/PowerShell and CRLF line endings, so without the
 *   pin every result path would leak a backslash into the walk contract.
 * - A non-ASCII file name comes back through the UTF-8 pipeline instead of
 *   the console code page.
 *
 * A missing engine SKIPS (the script stays runnable on a dev machine and on
 * the ubuntu lane, where fd is absent); an assertion failure exits non-zero.
 * The argv strings come from src/search-engines.ts itself, so a changed argv
 * cannot leave this gate asserting a shape nothing runs any more — hence the
 * `pnpm check:engines` wrapper (`--experimental-strip-types`; on Node ≥ 23
 * plain `node scripts/win-engine-check.mjs --assert` works too).
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fdArgv, rgArgv } from '../src/search-engines.ts'

const assertMode = process.argv.includes('--assert')

/** Every run builds its own scratch tree (a runner and a dev machine share no fixed path). */
const scratch = mkdtempSync(join(tmpdir(), 'dsh-engine-check-'))
mkdirSync(join(scratch, 'src'))
writeFileSync(join(scratch, 'README.md'), 'readme')
writeFileSync(join(scratch, 'src', 'a.ts'), 'code')
writeFileSync(join(scratch, '中文文件名.ts'), 'code')

let failed = false

function run(label, binary, args, { checkUnicode = false } = {}) {
  let stdout
  try {
    stdout = execFileSync(binary, args, { cwd: scratch, encoding: 'buffer' })
  } catch (error) {
    // A missing engine is a SKIP, not a failure: fd is absent on the ubuntu
    // lane and on most dev machines.
    console.log(`=== ${label} (${binary}) SKIPPED ===`)
    console.log(String(error.stderr ?? error.message).split('\n')[0])
    return
  }
  const hasBackslash = stdout.includes(92)
  const hasCR = stdout.includes(13)
  const text = stdout.toString('utf8')
  console.log(`=== ${label} (${binary}) ===`)
  console.log('backslash:', hasBackslash, '| CR:', hasCR)
  console.log('raw:', JSON.stringify(text))
  if (!assertMode) return
  if (hasBackslash || hasCR) {
    console.error(`ASSERT FAIL: ${label} leaked backslash/CR into output`)
    failed = true
  }
  if (checkUnicode && !text.includes('中文文件名.ts')) {
    console.error(`ASSERT FAIL: ${label} missed the non-ASCII file name`)
    failed = true
  }
}

if (process.argv.includes('--probe')) {
  // --probe: what the plugin's own argv produces for a query that hits a
  // directory, a file and a non-ASCII name. Manual, not asserted.
  run('rg argv (query=util)', 'rg', rgArgv('util'), { checkUnicode: false })
  run('fd argv (query=util)', 'fd', fdArgv(10, 'util'))
} else {
  run('rg argv (query=中文)', 'rg', rgArgv('中文'), { checkUnicode: true })
  run('fd argv (query=中文)', 'fd', fdArgv(10, '中文'), { checkUnicode: true })
  // A query with no non-ASCII bytes still exercises the path-separator pin.
  run('rg argv (query=a)', 'rg', rgArgv('a'))
  run('fd argv (query=a)', 'fd', fdArgv(10, 'a'))
}

rmSync(scratch, { recursive: true, force: true })
if (failed) process.exit(1)
