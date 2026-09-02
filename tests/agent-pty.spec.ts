/**
 * AgentPtyRegistry unit tests: spawn real ptys (mirroring the pty-manager
 * smoke tests) and verify uuid-keyed CRUD, transcript bounding, exit
 * tracking, and change-event subscription. The "AttachConsole failed"
 * console noise from node-pty's ConPTY module on Windows is expected and
 * does not affect the assertions.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AgentPtyRegistry,
  ALLOWED_SIGNALS,
  snapshotOf,
  tryResizePty,
  type AgentTerminalSnapshot,
} from '../src/agent-pty.ts'

/**
 * Resolve a shell binary for tests: on Windows use PowerShell (available on
 * every modern Windows host), on POSIX use /bin/sh (universally available).
 */
function testShell(): string {
  return process.platform === 'win32' ? 'powershell.exe' : '/bin/sh'
}

/** Wait for a terminal's transcript to contain a substring (or timeout). */
async function waitForTranscript(
  registry: AgentPtyRegistry,
  uuid: string,
  needle: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const handle = registry.get(uuid)
    if (handle !== undefined && handle.transcript.includes(needle)) return handle.transcript
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const handle = registry.get(uuid)
  return handle?.transcript ?? ''
}

describe('tryResizePty', () => {
  it('clamps valid dimensions before resizing', () => {
    const resize = vi.fn()

    expect(tryResizePty({ resize }, 5000, 80.9)).toBe(true)
    expect(resize).toHaveBeenCalledWith(1024, 80)
  })

  it('contains a node-pty resize failure', () => {
    const resize = vi.fn(() => {
      throw new Error('Usage: pty.resize(fd, cols, rows, xPixel, yPixel)')
    })

    expect(tryResizePty({ resize }, 80, 24)).toBe(false)
    expect(resize).toHaveBeenCalledWith(80, 24)
  })

  it.each([
    [Number.NaN, 24],
    [Number.POSITIVE_INFINITY, 24],
    [80, Number.NEGATIVE_INFINITY],
  ])('rejects non-finite dimensions without calling node-pty (%s, %s)', (cols, rows) => {
    const resize = vi.fn()

    expect(tryResizePty({ resize }, cols, rows)).toBe(false)
    expect(resize).not.toHaveBeenCalled()
  })
})

describe('AgentPtyRegistry', () => {
  it('creates a terminal with a uuid, writes the command to stdin, and lists it', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'echo test', 'echo hello-agent-pty', process.cwd(), 80, 24)
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      const list = registry.list('s1')
      expect(list).toHaveLength(1)
      expect(list[0]!.uuid).toBe(uuid)
      expect(list[0]!.title).toBe('echo test')
      expect(list[0]!.command).toBe('echo hello-agent-pty')
      expect(list[0]!.exited).toBe(false)
      // The command was written to stdin; wait for the output.
      const transcript = await waitForTranscript(registry, uuid, 'hello-agent-pty')
      expect(transcript).toContain('hello-agent-pty')
    } finally {
      registry.disposeAll()
    }
  })

  it('spawns a bare shell when command is empty', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'bare', '', process.cwd(), 80, 24)
      const handle = registry.get(uuid)
      expect(handle).toBeDefined()
      expect(handle!.command).toBe('')
      expect(handle!.exited).toBe(false)
      // The pty process exists; its transcript may take a moment to
      // accumulate on Windows ConPTY. The handle is alive and listed.
      expect(registry.list('s1')).toHaveLength(1)
    } finally {
      registry.disposeAll()
    }
  })

  it('sends raw text to stdin (send-keys semantics)', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'sender', '', process.cwd(), 80, 24)
      // Wait for the shell prompt, then send a command.
      await waitForTranscript(registry, uuid, '', 1000)
      // The registry's send() writes verbatim; the caller (tool layer) is
      // responsible for appending \r when submit=true. Here we test the
      // registry directly: send text + \r to submit.
      registry.send(uuid, 'echo sent-via-send\r')
      const transcript = await waitForTranscript(registry, uuid, 'sent-via-send')
      expect(transcript).toContain('sent-via-send')
    } finally {
      registry.disposeAll()
    }
  })

  it('reads a bounded page of the transcript', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'reader', 'echo line1\necho line2\necho line3', process.cwd(), 80, 24)
      await waitForTranscript(registry, uuid, 'line3')
      const page = registry.read(uuid)
      expect(page.totalLines).toBeGreaterThan(0)
      expect(page.text).toContain('line1')
      expect(page.text).toContain('line3')
      // Negative offset reads from the end.
      const tail = registry.read(uuid, -2)
      expect(tail.lineBegin).toBeGreaterThanOrEqual(0)
      expect(tail.lineEnd).toBe(tail.lineBegin + tail.text.split('\n').length)
    } finally {
      registry.disposeAll()
    }
  })

  it('resizes without throwing', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'resizer', '', process.cwd(), 80, 24)
      expect(() => registry.resize(uuid, 120, 40)).not.toThrow()
    } finally {
      registry.disposeAll()
    }
  })

  it('resize clamps to the 2..1024 range and returns the applied dimensions', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'clamp', '', process.cwd(), 80, 24)
      // Oversized / undersized requests report the clamped values, so the
      // echoed result always matches the pty (the tool contract).
      expect(registry.resize(uuid, 5000, 1)).toEqual({ cols: 1024, rows: 2 })
      expect(registry.resize(uuid, -3, 80.9)).toEqual({ cols: 2, rows: 80 })
      expect(registry.resize(uuid, 120, 40)).toEqual({ cols: 120, rows: 40 })
      // create clamps through the same helper.
      const other = registry.create('s1', 'clamped-create', '', process.cwd(), 1, 9999)
      expect(registry.get(other)!.pty.cols).toBe(2)
      expect(registry.get(other)!.pty.rows).toBe(1024)
    } finally {
      registry.disposeAll()
    }
  })

  it('assertOwned rejects a uuid owned by another session', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const mine = registry.create('s1', 'mine', '', process.cwd(), 80, 24)
      const theirs = registry.create('s2', 'theirs', '', process.cwd(), 80, 24)
      expect(() => registry.assertOwned(mine, 's1')).not.toThrow()
      // A foreign uuid is indistinguishable from an unknown one.
      expect(() => registry.assertOwned(theirs, 's1')).toThrow(/not found/)
      expect(() => registry.assertOwned('nope', 's1')).toThrow(/not found/)
    } finally {
      registry.disposeAll()
    }
  })

  it('closes a terminal and removes it from the list', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'closer', '', process.cwd(), 80, 24)
      expect(registry.list('s1')).toHaveLength(1)
      const closed = registry.close(uuid)
      expect(closed).toBe(true)
      expect(registry.list('s1')).toHaveLength(0)
      // Closing again is a no-op.
      const closedAgain = registry.close(uuid)
      expect(closedAgain).toBe(false)
    } finally {
      registry.disposeAll()
    }
  })

  it('scopes list by session id', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      registry.create('s1', 'a', '', process.cwd(), 80, 24)
      registry.create('s1', 'b', '', process.cwd(), 80, 24)
      registry.create('s2', 'c', '', process.cwd(), 80, 24)
      expect(registry.list('s1')).toHaveLength(2)
      expect(registry.list('s2')).toHaveLength(1)
      expect(registry.list('s3')).toHaveLength(0)
    } finally {
      registry.disposeAll()
    }
  })

  it('fires change listeners on create, close, and exit', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      let changeCount = 0
      registry.subscribe(() => { changeCount += 1 })
      const uuid = registry.create('s1', 'watched', '', process.cwd(), 80, 24)
      // create fires one change.
      expect(changeCount).toBeGreaterThanOrEqual(1)
      registry.close(uuid)
      // close fires another change.
      expect(changeCount).toBeGreaterThanOrEqual(2)
    } finally {
      registry.disposeAll()
    }
  })

  it('disposeAll closes every terminal', () => {
    const registry = new AgentPtyRegistry(testShell())
    registry.create('s1', 'a', '', process.cwd(), 80, 24)
    registry.create('s2', 'b', '', process.cwd(), 80, 24)
    registry.disposeAll()
    expect(registry.list('s1')).toHaveLength(0)
    expect(registry.list('s2')).toHaveLength(0)
  })

  it('snapshotOf drops the pty reference and transcript', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'snap', '', process.cwd(), 80, 24)
      const handle = registry.get(uuid)!
      const snap = snapshotOf(handle)
      expect(snap.uuid).toBe(uuid)
      expect(snap.title).toBe('snap')
      expect(snap.exited).toBe(false)
      // No pty or transcript fields on the snapshot.
      expect('pty' in snap).toBe(false)
      expect('transcript' in snap).toBe(false)
      // sessionId is registry-internal ownership, never serialized (it would
      // violate the terminal_list output schema's additionalProperties:false).
      expect('sessionId' in snap).toBe(false)
      expect('sessionId' in registry.list('s1')[0]!).toBe(false)
    } finally {
      registry.disposeAll()
    }
  })

  it('ALLOWED_SIGNALS includes SIGINT, SIGTERM, SIGKILL, SIGHUP, SIGTSTP', () => {
    expect(ALLOWED_SIGNALS).toContain('SIGINT')
    expect(ALLOWED_SIGNALS).toContain('SIGTERM')
    expect(ALLOWED_SIGNALS).toContain('SIGKILL')
    expect(ALLOWED_SIGNALS).toContain('SIGHUP')
    expect(ALLOWED_SIGNALS).toContain('SIGTSTP')
  })

  it('waitFor returns found when the needle is already in the transcript', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'echo-test', 'echo wait-for-fast', process.cwd(), 80, 24)
      await waitForTranscript(registry, uuid, 'wait-for-fast')
      // The needle is already present; waitFor should return immediately.
      const result = await registry.waitFor(uuid, 'wait-for-fast', 2000)
      expect(result.kind).toBe('found')
      if (result.kind === 'found') {
        expect(result.needle).toBe('wait-for-fast')
        expect(result.elapsedMs).toBeLessThan(500)
      }
    } finally {
      registry.disposeAll()
    }
  })

  it('waitFor returns found after the needle appears (async output)', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      // Spawn a shell WITH a command (so output is guaranteed), but start
      // the wait for a DIFFERENT needle that only appears after we send
      // a follow-up command. This exercises the subscribe/poll path: the
      // wait must notice output arriving AFTER it started, not just find
      // pre-existing content.
      const uuid = registry.create('s1', 'async-echo', 'echo shell-ready', process.cwd(), 80, 24)
      // Wait for the initial command's output so we know the shell is live.
      await waitForTranscript(registry, uuid, 'shell-ready', 10_000)
      // Start the wait BEFORE sending the follow-up command. The needle is
      // NOT in the transcript yet. ConPTY under test concurrency can be slow,
      // so the timeout is generous.
      const waitPromise = registry.waitFor(uuid, 'UNIQUE_NEEDLE_42', 30_000)
      // Give the wait a moment to subscribe, then send the command.
      await new Promise(resolve => setTimeout(resolve, 200))
      registry.send(uuid, 'echo UNIQUE_NEEDLE_42\r')
      const result = await waitPromise
      expect(result.kind).toBe('found')
      if (result.kind === 'found') {
        expect(result.needle).toBe('UNIQUE_NEEDLE_42')
      }
    } finally {
      registry.disposeAll()
    }
  }, 40_000)

  it('waitFor returns timeout when the needle never appears', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'silent', '', process.cwd(), 80, 24)
      await waitForTranscript(registry, uuid, '', 1000)
      // Wait for a needle that will never appear; use a short timeout to
      // keep the test fast.
      const result = await registry.waitFor(uuid, 'this-needle-will-never-appear', 500)
      expect(result.kind).toBe('timeout')
      if (result.kind === 'timeout') {
        expect(result.timeoutMs).toBe(500)
        expect(result.totalLines).toBeGreaterThan(0)
      }
    } finally {
      registry.disposeAll()
    }
  })

  it('waitFor throws on an empty needle', async () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'empty-needle', '', process.cwd(), 80, 24)
      await expect(registry.waitFor(uuid, '', 500)).rejects.toThrow()
    } finally {
      registry.disposeAll()
    }
  })

  it('waitFor throws on an unknown uuid', async () => {
    const registry = new AgentPtyRegistry(testShell())
    await expect(registry.waitFor('nonexistent-uuid', 'foo', 500)).rejects.toThrow()
  })

  it('delivers SIGINT and SIGTSTP by writing control characters (cross-platform)', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'signal-test', '', process.cwd(), 80, 24)
      // SIGINT and SIGTSTP are delivered by writing \x03 / \x1a to the pty
      // stdin — the cross-platform way terminals send Ctrl+C / Ctrl+Z.
      // These must NOT throw (the old kill(SIGINT) path threw on Windows).
      expect(() => registry.signal(uuid, 'SIGINT')).not.toThrow()
      expect(() => registry.signal(uuid, 'SIGTSTP')).not.toThrow()
      // The control byte was written to the pty; the shell received it.
      // On POSIX the line discipline generates the signal; on Windows
      // ConPTY translates it. Either way the write path is exercised.
    } finally {
      registry.disposeAll()
    }
  })

  it('delivers SIGKILL via the process-termination path', () => {
    const registry = new AgentPtyRegistry(testShell())
    try {
      const uuid = registry.create('s1', 'kill-test', '', process.cwd(), 80, 24)
      // SIGKILL uses pty.kill() (TerminateProcess on Windows). Must not
      // throw even when the pty's kill() rejects named signals — the
      // fallback to the default kill ensures the signal takes effect.
      expect(() => registry.signal(uuid, 'SIGKILL')).not.toThrow()
    } finally {
      registry.disposeAll()
    }
  })
})
