import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url)).replaceAll('\\', '/')
const script = readFileSync(join(root, 'scripts/e2e-aggregate-mount.sh'), 'utf8')
const hasBash = spawnSync('bash', ['--version'], { stdio: 'ignore' }).status === 0

it.skipIf(!hasBash)('exchanges the full aggregate launch URL and authenticates both unchanged API probes', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-aggregate-auth-')).replaceAll('\\', '/')
  const launch = 'http://127.0.0.1:4199/?token=aggregate-test-token'
  try {
    expect(spawnSync('bash', ['-n', join(root, 'scripts/e2e-aggregate-mount.sh')]).status).toBe(0)
    const start = script.indexOf('E2E_READY_RE=')
    expect(start).toBeGreaterThan(-1)
    const result = spawnSync('bash', ['-c', `
set -euo pipefail
E2E_TAG=e2e-aggregate-auth
source "$ROOT/scripts/e2e-common.sh"
OUT_LOG="$SCRATCH/out.log"
ERR_LOG="$SCRATCH/err.log"
printf 'dsh web: %s (LAN: http://example.invalid:4199)\\n' "$TEST_LAUNCH_URL" > "$OUT_LOG"
: > "$ERR_LOG"
SERVER_PID=$$
curl() {
  printf '%s\\n' "$*" >> "$SCRATCH/curl.log"
  case "\${!#}" in
    "$TEST_LAUNCH_URL") : > "$SCRATCH/auth.cookies" ;;
    */settings.get) printf '%s' '{"ok":true}' ;;
    */__e2e_unknown__) printf '404' ;;
    *) return 1 ;;
  esac
}
${script.slice(start)}
`], {
      encoding: 'utf8', timeout: 5_000,
      env: { ...process.env, ROOT: root, SCRATCH: scratch, TEST_LAUNCH_URL: launch },
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).not.toContain('aggregate-test-token')
    const calls = readFileSync(join(scratch, 'curl.log'), 'utf8').trim().split('\n')
    expect(calls).toHaveLength(3)
    expect(calls[0]).toContain(`--cookie-jar ${scratch}/auth.cookies`)
    expect(calls[0]).toContain(launch)
    // No redirect-following flag. Check the FLAGS, never the whole line: the
    // scratch path is a mkdtemp name, and a random suffix can put an `L` right
    // after a `-` (`dsh-aggregate-auth-6mLM51`), which a line-wide regex reads
    // as a `-L` flag (the Windows lane caught exactly that).
    const shortFlags = calls[0]!.split(/\s+/).filter(token => token.startsWith('-') && !token.startsWith('--'))
    expect(shortFlags.some(flag => flag.includes('L'))).toBe(false)
    expect(calls[0]).not.toContain('--location')
    for (const call of calls.slice(1)) {
      expect(call).toContain(`--cookie ${scratch}/auth.cookies`)
      expect(call).toContain('-X POST http://127.0.0.1:4199/sidebar/api/')
      expect(call).not.toContain('?token=')
    }
    expect(result.stdout).toContain('HTTP 404')
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
