/**
 * Windows(任意 OS)引擎输出形状检查/断言:
 *  - 无参:打印 rg/fd 在有无 `--path-separator /` 时的字节级输出(人工检查用)
 *  - --assert:CI 门禁模式——存在的引擎必须满足:
 *      * `--path-separator /` 输出不含 `\`(backslash)与 `\r`(CR)
 *      * 中文文件名可正常命中(UTF-8 编码链路)
 *    任一断言失败退出码非零(红灯);引擎缺失则跳过(不算失败)。
 * 用法: node scripts/win-engine-check.cjs [--assert]
 */
const { execFileSync } = require('node:child_process')
const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const assertMode = process.argv.includes('--assert')

function hasBinary(binary) {
  try {
    execFileSync(binary, ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// 每次运行自建 scratch 目录(CI 机器没有固定的 C:\Users\y\wintest)
const scratch = mkdtempSync(join(tmpdir(), 'dsh-engine-check-'))
mkdirSync(join(scratch, 'src'))
writeFileSync(join(scratch, 'README.md'), 'readme')
writeFileSync(join(scratch, 'src', 'a.ts'), 'code')
writeFileSync(join(scratch, '中文文件名.ts'), 'code')

let failed = false

function run(label, binary, args, opts = {}) {
  try {
    const out = execFileSync(binary, args, { cwd: scratch, encoding: 'buffer' })
    const hasBackslash = out.includes(92)
    const hasCR = out.includes(13)
    console.log(`=== ${label} (${binary}) ===`)
    console.log('backslash:', hasBackslash, '| CR:', hasCR)
    console.log('raw:', JSON.stringify(out.toString('utf8')))
    if (assertMode && opts.pinned !== false) {
      // The default-shape runs (opts.pinned === false) are DEMO cases —
      // un-pinned engines leak '\'/'.\' by design; only the pinned
      // (--path-separator /) and Chinese-name runs are asserted.
      if (hasBackslash || hasCR) {
        console.error(`ASSERT FAIL: ${label} leaked backslash/CR into output`)
        failed = true
      }
      // Chinese filename must be hit through the UTF-8 pipeline.
      if (opts.chinese && !out.toString('utf8').includes('中文文件名.ts')) {
        console.error(`ASSERT FAIL: ${label} missed the Chinese filename`)
        failed = true
      }
    }
  } catch (err) {
    console.log(`=== ${label} (${binary}) SKIPPED/FAILED ===`)
    console.log(String(err.stderr ?? err.message).split('\n')[0])
  }
}

// Default-shape runs are DEMO cases (un-pinned output leaks '\' by design —
// that is exactly the review concern); only the pinned/Chinese runs assert.
run('rg default (no path-separator)', 'rg', ['--files', '--hidden', '--no-ignore', '.'], { pinned: false })
run('rg with --path-separator /', 'rg', ['--files', '--hidden', '--no-ignore', '--path-separator', '/', '.'])
run('fd default (no path-separator)', 'fd', ['--hidden', '--no-ignore', '--exclude', '.git', '--fixed-strings', '--ignore-case', 'a', '.'], { pinned: false })
run('fd with --path-separator /', 'fd', ['--hidden', '--no-ignore', '--exclude', '.git', '--fixed-strings', '--ignore-case', '--path-separator', '/', 'a', '.'])

const rgCn = ['--files', '--hidden', '--no-ignore', '--iglob', '*中文*', '--path-separator', '/', '.']
const fdCn = ['--hidden', '--no-ignore', '--exclude', '.git', '--fixed-strings', '--ignore-case', '--path-separator', '/', '中文', '.']
run('rg Chinese filename', 'rg', rgCn, { chinese: true })
run('fd Chinese filename', 'fd', fdCn, { chinese: true })

rmSync(scratch, { recursive: true, force: true })
if (failed) process.exit(1)