/**
 * Eight model-facing tools for the agent-owned sidebar terminals (tmux
 * semantics: spawn-and-detach, send-keys, read, wait-for, resize, signal,
 * close, list). Each tool binds to the calling agent's session through
 * `exec.agent.session.id`, so the model never passes a sessionId — the
 * agent identity is the scope.
 *
 * Conventions (per plugin-development-guide.md §3):
 *   C1 — parameters schema-validated before `execute` runs.
 *   C4 — `execute` returns one canonical JSON value; `render` is a separate
 *        pure text projection.
 *   C6 — `exec.signal.throwIfAborted()` before any spawn.
 *   C10 — no UI/transport vocabulary in the canonical value.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from './context-types.ts'
import {
  AgentPtyRegistry,
  ALLOWED_SIGNALS,
  type AgentTerminalSignal,
  type AgentTerminalSnapshot,
} from './agent-pty.ts'

/** Maximum UTF-8 bytes of one `terminal_read` result text. */
const READ_BYTE_LIMIT = 256 * 1024

/**
 * Bound a string to a byte limit, marking truncation. Truncation never
 * splits a multi-byte UTF-8 sequence: when the byte cap lands inside one,
 * the walk-back retreats to the sequence's leading byte so the retained
 * prefix decodes cleanly (a split would decode to U+FFFD).
 * @internal exported for the unit tests, like {@link snapshotOf}.
 */
export function boundBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8')
  if (buf.byteLength <= maxBytes) return { text, truncated: false }
  // The byte at `end` is a continuation byte (10xxxxxx) exactly when the
  // character that started before `end` spills past the cap. Stop at the
  // first non-continuation byte — the retained prefix is then intact.
  let end = maxBytes
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) end -= 1
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true }
}

/** Pure text projection helper (the canonical value is already structured). */
function textRender<T>(fn: (value: T) => string): (_args: unknown, value: unknown) => ContentBlock[] {
  return (_args, value) => [{ type: 'text', text: fn(value as T) }]
}

/** Extract the calling agent or throw the canonical "no agent" error. */
function requireAgent(agent: Agent | undefined): Agent {
  if (agent === undefined) {
    throw new Error('sidebar terminal tools require an initiating agent')
  }
  return agent
}

/** Resolve the calling agent's session id (the registry scope + ownership key). */
function sessionIdOf(exec: ToolRunContext): string {
  return requireAgent(exec.agent).session.id
}

/**
 * Register the eight terminal tools against the host tool registry. The
 * `resolveCwd` callback threads the live session cwd (authoritative from the
 * session store, falling back to the process cwd) so a freshly-created
 * terminal lands in the right directory without the model passing it.
 * Every uuid-keyed tool first asserts the terminal belongs to the calling
 * session (`registry.assertOwned`), so one agent can never reach another
 * session's terminals.
 * @param ctx - host plugin context (carries the tools service).
 * @param registry - the agent-owned terminal registry.
 * @param resolveCwd - live cwd resolver for one session id.
 * @returns a disposer that unregisters all eight tools (the caller gates
 * registration on the side-card setting and calls this to turn them off).
 */
export function registerTools(
  ctx: Context,
  registry: AgentPtyRegistry,
  resolveCwd: (sessionId: string) => string,
  readShellOverrides: () => { shell?: string; shellArgs?: string[] },
): () => void {
  const disposers: Array<() => void> = []
  const register = (tool: ReturnType<typeof defineTool>): void => {
    disposers.push(ctx.tools.register(tool))
  }

  register(defineTool({
    name: 'terminal_create',
    description:
      'Open a persistent terminal in the sidebar and run a command in it. '
      + 'Spawns an interactive shell, writes the command + Enter to its stdin, and returns a uuid handle. '
      + 'The terminal stays alive after the command exits — send more input with terminal_send (set submit=true to run a command), '
      + 'read output with terminal_read, send Ctrl+C with terminal_signal(signal="SIGINT"), '
      + 'and close it with terminal_close when done. '
      + 'Use this for interactive shells, REPLs, long-running dev servers, '
      + 'or any work that needs persistent terminal state across tool calls. '
      + 'The terminal appears as a new tab in the right sidebar (titled with the `title` you provide) so the user can watch and interact with it.',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: 'Short human-readable label for the terminal tab (e.g. "dev server", "python repl").',
      },
      command: {
        type: 'string',
        required: true,
        description: 'Shell command to run in the freshly spawned shell. The host appends an Enter key automatically — do NOT include a trailing newline. Pass "" to open a bare shell with no command.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uuid: { type: 'string', required: true, description: 'Opaque handle for the new terminal. Pass to terminal_send / terminal_read / terminal_resize / terminal_signal / terminal_close.' },
          title: { type: 'string', required: true, description: 'The title you provided (echoed for confirmation).' },
        },
      },
      render: textRender((v: { uuid: string; title: string }) =>
        `Opened terminal "${v.title}" (uuid: ${v.uuid}). The sidebar tab appears automatically; use terminal_read to see output and terminal_send (with submit=true) to run more commands.`,
      ),
    },
    execute: (args: { title: string; command: string }, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      const cwd = resolveCwd(sessionId)
      const { shell, shellArgs } = readShellOverrides()
      const uuid = registry.create(sessionId, args.title, args.command, cwd, 80, 24, shell, shellArgs)
      return Promise.resolve({ uuid, title: args.title })
    },
  }))

  register(defineTool({
    name: 'terminal_list',
    description:
      'List every terminal the current agent has opened in this session. Returns each terminal\'s uuid, title, '
      + 'the command it was started with, and whether the top-level process has exited (with exit code/signal if so). '
      + 'Use this to recover state after a long sequence of tool calls or to find a terminal you forgot to close.',
    parameters: {},
    output: {
      schema: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            uuid: { type: 'string', required: true },
            title: { type: 'string', required: true },
            command: { type: 'string', required: true },
            exited: { type: 'boolean', required: true },
            exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
            exitSignal: { oneOf: [{ type: 'string' }, { type: 'null' }] },
          },
        },
      },
      render: (_args, value) => {
        const list = value as AgentTerminalSnapshot[]
        if (list.length === 0) return [{ type: 'text', text: 'No agent terminals open in this session.' }]
        const lines = list.map((t) => {
          const status = t.exited
            ? `exited (code ${t.exitCode ?? '?'}, signal ${t.exitSignal ?? 'none'})`
            : 'running'
          return `  ${t.uuid}  "${t.title}"  [${status}]  $ ${t.command}`
        })
        return [{ type: 'text', text: `Agent terminals in this session:\n${lines.join('\n')}` }]
      },
    },
    execute: (_args, exec) => {
      const sessionId = sessionIdOf(exec)
      return Promise.resolve(registry.list(sessionId))
    },
  }))

  register(defineTool({
    name: 'terminal_send',
    description:
      'Send raw text (keystrokes) to a terminal opened with terminal_create — tmux send-keys semantics. '
      + 'The text is written verbatim to the pty stdin. '
      + 'To submit a command, set submit=true (appends an Enter key); do NOT put "\\n" or "\\r" in the text yourself. '
      + 'To send Ctrl+C (interrupt the running command), use the terminal_signal tool with signal="SIGINT" — do NOT try to send the control character "\\u0003" as text. '
      + 'Use terminal_signal with signal="SIGTSTP" for Ctrl+Z (suspend) as well. '
      + 'This tool does NOT wait for the command to finish or for output to settle — pair with terminal_read to observe the result. '
      + 'Throws if the terminal has exited.',
    parameters: {
      uuid: {
        type: 'string',
        required: true,
        description: 'Terminal uuid from terminal_create or terminal_list.',
      },
      text: {
        type: 'string',
        required: true,
        description: 'UTF-8 text to write to the terminal stdin (verbatim, no shell escaping). Do not include trailing newlines — use the submit flag instead.',
      },
      submit: {
        type: 'boolean',
        description: 'Append an Enter key (carriage return) after the text to submit a command. Default: false. Set to true when sending a command to run; leave false for partial input or control sequences.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uuid: { type: 'string', required: true },
          bytes: { type: 'integer', required: true, description: 'Number of UTF-8 bytes written (including the Enter key if submit was true).' },
        },
      },
      render: textRender((v: { uuid: string; bytes: number }) =>
        `Sent ${v.bytes} byte(s) to terminal ${v.uuid}.`,
      ),
    },
    execute: (args: { uuid: string; text: string; submit?: boolean }, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      registry.assertOwned(args.uuid, sessionId)
      const payload = args.submit === true ? `${args.text}\r` : args.text
      registry.send(args.uuid, payload)
      return Promise.resolve({ uuid: args.uuid, bytes: Buffer.byteLength(payload, 'utf8') })
    },
  }))

  register(defineTool({
    name: 'terminal_read',
    description:
      'Read a bounded page of retained output from an agent terminal without sending input. '
      + 'The host keeps up to ~1 MiB of scrollback; this tool returns up to 500 lines per call. '
      + 'Use `offset` to paginate forward ( 0-based from the start of the retained transcript ) or backward ( negative reads from the end, e.g. -50 reads the last 50 lines ). '
      + 'Returns `totalLines` so you know how much scrollback remains. '
      + 'Output is bounded to 256 KiB per call; longer pages are truncated with the `truncated` flag.',
    parameters: {
      uuid: {
        type: 'string',
        required: true,
        description: 'Terminal uuid from terminal_create or terminal_list.',
      },
      offset: {
        type: 'number',
        description: '0-based line offset from the start of the retained transcript (default 0). Negative reads from the end (e.g. -50 = last 50 lines).',
      },
      count: {
        type: 'number',
        description: 'Maximum lines to return (default 500, hard cap 500).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true, description: 'The slice of transcript for the requested page.' },
          totalLines: { type: 'integer', required: true, description: 'Total lines in the retained transcript.' },
          lineBegin: { type: 'integer', required: true, description: '0-based index of the first line in `text` (inclusive).' },
          lineEnd: { type: 'integer', required: true, description: '0-based index of the last line in `text` (exclusive).' },
          truncated: { type: 'boolean', required: true, description: 'Whether `text` was truncated to fit the 256 KiB read cap.' },
        },
      },
      render: (_args, value) => {
        const v = value as { text: string; totalLines: number; lineBegin: number; lineEnd: number; truncated: boolean }
        const head = `[lines ${v.lineBegin}..${v.lineEnd} of ${v.totalLines}${v.truncated ? '; truncated to 256KiB' : ''}]`
        return [{ type: 'text', text: `${head}\n${v.text}` }]
      },
    },
    execute: (args: { uuid: string; offset?: number; count?: number }, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      registry.assertOwned(args.uuid, sessionId)
      const result = registry.read(args.uuid, args.offset, args.count)
      const bounded = boundBytes(result.text, READ_BYTE_LIMIT)
      return Promise.resolve({
        text: bounded.text,
        totalLines: result.totalLines,
        lineBegin: result.lineBegin,
        lineEnd: result.lineEnd,
        truncated: bounded.truncated,
      })
    },
  }))

  register(defineTool({
    name: 'terminal_wait_for',
    description:
      'Block until a substring appears in a terminal\'s retained transcript, or until the timeout elapses, or until the terminal exits — whichever happens first. '
      + 'Use this to synchronize on command completion cues ( e.g. a shell prompt, "done", "Listening on", "Build successful" ) '
      + 'without busy-polling terminal_read. '
      + 'The wait scans the FULL retained transcript (up to ~1 MiB) on every poll, so a needle that scrolled past the most recent chunk is still a match. '
      + 'Returns `found` with the line/column of the first occurrence, `timeout` if the needle did not appear in time, or `exited` if the terminal process died before the needle appeared. '
      + 'Default timeout is 10 seconds; raise it for long-running commands ( dev servers, test suites ). '
      + 'The wait is cooperative: a tool-call cancel ( or agent turn end ) aborts it immediately.',
    parameters: {
      uuid: {
        type: 'string',
        required: true,
        description: 'Terminal uuid from terminal_create or terminal_list.',
      },
      needle: {
        type: 'string',
        required: true,
        description: 'Substring to wait for (case-sensitive, verbatim). Must be non-empty.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum wait in milliseconds (default 10000, i.e. 10s). Clamped to a minimum of 100ms.',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'found' },
              needle: { type: 'string', required: true },
              line: { type: 'integer', required: true, description: '0-based line index in the retained transcript where the needle first appeared.' },
              column: { type: 'integer', required: true, description: '0-based column index within that line where the match starts.' },
              elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds from wait start to match.' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'timeout' },
              needle: { type: 'string', required: true },
              timeoutMs: { type: 'integer', required: true, description: 'The configured timeout that elapsed.' },
              totalLines: { type: 'integer', required: true, description: 'Total lines retained when the timeout fired. Call terminal_read to inspect the tail.' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'exited' },
              needle: { type: 'string', required: true },
              exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Exit code, if known.' },
              exitSignal: { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Exit signal name, if killed by a signal.' },
            },
          },
        ],
      },
      render: (_args, value) => {
        const v = value as { kind: 'found' | 'timeout' | 'exited'; needle: string; elapsedMs?: number; timeoutMs?: number; line?: number; column?: number; exitCode?: number | null; exitSignal?: string | null }
        if (v.kind === 'found') {
          return [{ type: 'text', text: `Found "${v.needle}" at line ${v.line}, column ${v.column} (after ${v.elapsedMs}ms).` }]
        }
        if (v.kind === 'timeout') {
          return [{ type: 'text', text: `Timed out after ${v.timeoutMs}ms waiting for "${v.needle}". Call terminal_read to inspect the transcript.` }]
        }
        const exitInfo = v.exitCode !== undefined && v.exitCode !== null ? ` (exit code ${v.exitCode})` : ''
        return [{ type: 'text', text: `Terminal exited before "${v.needle}" appeared${exitInfo}.` }]
      },
    },
    async execute(args: { uuid: string; needle: string; timeout_ms?: number }, exec) {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      registry.assertOwned(args.uuid, sessionId)
      // The registry validates the needle (empty → bad-request) and returns
      // the camelCase result the schema above declares directly — no
      // field-by-field projection.
      const timeoutMs = args.timeout_ms ?? 10_000
      return await registry.waitFor(args.uuid, args.needle, timeoutMs, exec.signal)
    },
  }))

  register(defineTool({
    name: 'terminal_resize',
    description:
      'Resize an agent terminal\'s pty ( cols × rows ). The host clamps both to a 2..1024 sane range. '
      + 'Most shells redraw their prompt and any full-screen TUI on the next output frame. '
      + 'No-op if the terminal has exited. Returns the dimensions actually applied.',
    parameters: {
      uuid: { type: 'string', required: true, description: 'Terminal uuid from terminal_create or terminal_list.' },
      cols: { type: 'integer', required: true, description: 'New column count ( clamped to 2..1024 ).' },
      rows: { type: 'integer', required: true, description: 'New row count ( clamped to 2..1024 ).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uuid: { type: 'string', required: true },
          cols: { type: 'integer', required: true },
          rows: { type: 'integer', required: true },
        },
      },
      render: textRender((v: { uuid: string; cols: number; rows: number }) =>
        `Resized terminal ${v.uuid} to ${v.cols}×${v.rows}.`,
      ),
    },
    execute: (args: { uuid: string; cols: number; rows: number }, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      registry.assertOwned(args.uuid, sessionId)
      const dims = registry.resize(args.uuid, args.cols, args.rows)
      return Promise.resolve({ uuid: args.uuid, ...dims })
    },
  }))

  register(defineTool({
    name: 'terminal_signal',
    description:
      'Send a POSIX signal to an agent terminal\'s foreground process — this is how you send Ctrl+C, Ctrl+Z, etc. '
      + 'Use signal="SIGINT" for Ctrl+C (interrupt the running command), signal="SIGTERM" to request termination, '
      + 'signal="SIGKILL" to force-kill the pty, signal="SIGHUP" to hang up (many shells exit), signal="SIGTSTP" for Ctrl+Z (suspend). '
      + 'Do NOT try to send control characters (like "\\u0003") through terminal_send — use this tool instead. '
      + 'On Windows, only SIGKILL and SIGTERM are effective — others are accepted but may no-op. '
      + 'No-op if the terminal has already exited. Use terminal_close to dispose of the terminal entirely.',
    parameters: {
      uuid: { type: 'string', required: true, description: 'Terminal uuid from terminal_create or terminal_list.' },
      signal: {
        type: 'string',
        required: true,
        enum: ALLOWED_SIGNALS as readonly string[],
        description: 'Signal to deliver: SIGINT (Ctrl+C) | SIGTERM | SIGKILL | SIGHUP | SIGTSTP (Ctrl+Z).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uuid: { type: 'string', required: true },
          signal: { type: 'string', required: true },
        },
      },
      render: textRender((v: { uuid: string; signal: AgentTerminalSignal }) =>
        `Sent ${v.signal} to terminal ${v.uuid}.`,
      ),
    },
    execute: (args: { uuid: string; signal: AgentTerminalSignal }, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      registry.assertOwned(args.uuid, sessionId)
      registry.signal(args.uuid, args.signal)
      return Promise.resolve({ uuid: args.uuid, signal: args.signal })
    },
  }))

  register(defineTool({
    name: 'terminal_close',
    description:
      'Close an agent terminal and release its process. The uuid becomes invalid for all subsequent tool calls. '
      + 'Idempotent: closing an already-closed uuid is a no-op. '
      + 'The corresponding sidebar tab is removed automatically when the host pushes the updated terminal list. '
      + 'Always close terminals you no longer need — the host keeps the pty alive until you do.',
    parameters: {
      uuid: { type: 'string', required: true, description: 'Terminal uuid from terminal_create or terminal_list.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          uuid: { type: 'string', required: true },
          closed: { type: 'boolean', required: true, description: 'Whether a live terminal was actually dropped (false if the uuid was already gone).' },
        },
      },
      render: textRender((v: { uuid: string; closed: boolean }) =>
        v.closed ? `Closed terminal ${v.uuid}.` : `Terminal ${v.uuid} was already closed.`,
      ),
    },
    execute: (args: { uuid: string }, exec) => {
      exec.signal.throwIfAborted()
      const sessionId = sessionIdOf(exec)
      registry.assertOwned(args.uuid, sessionId)
      const closed = registry.close(args.uuid)
      return Promise.resolve({ uuid: args.uuid, closed })
    },
  }))

  return () => {
    for (const dispose of disposers) dispose()
  }
}
