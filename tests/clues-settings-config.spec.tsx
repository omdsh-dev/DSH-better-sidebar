/**
 * S8 source configuration page (the S6 window body): CLI dependency details,
 * explicit re-check, one-click install behind a confirmed plan with progress
 * and cancellation, and authorization as an INDEPENDENT explicit action.
 *
 * The page never probes on its own timer, never logs in without a click and
 * never renders raw stdout/token/secrets — it only projects S2's sanitized
 * DTOs. Every failure keeps the surrounding settings and shows inline copy.
 *
 * Rendered with createRoot + act() in jsdom: the page's mount read and its
 * click paths are effects, so SSR would prove nothing here.
 */
// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { renderRoot, setupReactAct, type RenderedRoot } from './test-utils.ts'

setupReactAct()
beforeAll(() => {
  Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true })
})

import { SourceConfigPage } from '../src/client/clues/settings/config.tsx'
import type { ClueRuntimeApi } from '../src/client/clues/runtime-api.ts'
import type {
  ConnectionStatusProjection,
  DependencyInstallPlan,
  DependencyInstallTask,
  DependencyStatus,
} from '../src/clues/runtime/types.ts'

/** One dependency fixture with everything a real status carries. */
function dependency(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return {
    dependencyId: 'acme.cli',
    name: 'Acme CLI',
    command: 'acme',
    state: 'ready',
    platform: 'darwin',
    arch: 'arm64',
    supported: true,
    installable: true,
    minimumVersion: '1.2.0',
    recommendedVersion: '1.4.0',
    version: '1.4.0',
    executablePath: '/usr/local/bin/acme',
    resolvedFrom: 'path',
    lastCheckedAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  }
}

function connection(overrides: Partial<ConnectionStatusProjection> = {}): ConnectionStatusProjection {
  return {
    connectionId: 'acme.auth',
    name: 'Acme Auth',
    pluginId: 'test.plugin',
    configuration: 'ready',
    authorization: 'ready',
    credentialOwner: 'tool',
    capabilities: ['docs.read'],
    action: 'none',
    lastCheckedAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  }
}

function plan(overrides: Partial<DependencyInstallPlan> = {}): DependencyInstallPlan {
  return {
    planId: 'plan-1',
    dependencyId: 'acme.cli',
    name: 'Acme CLI',
    command: 'acme',
    version: '1.4.0',
    platform: 'darwin',
    arch: 'arm64',
    distribution: { kind: 'archive', source: 'GitHub releases', url: 'https://example.test/acme.zip' },
    targetDir: '/home/u/.dsh/tools/acme.cli/1.4.0',
    executablePath: '/home/u/.dsh/tools/acme.cli/1.4.0/bin/acme',
    installable: true,
    actions: ['download the official archive', 'verify sha256'],
    actionIds: ['download-archive', 'verify-sha256'],
    createdAt: '2026-10-17T00:00:00.000Z',
    expiresAt: '2026-10-17T00:10:00.000Z',
    ...overrides,
  }
}

function task(overrides: Partial<DependencyInstallTask> = {}): DependencyInstallTask {
  return {
    taskId: 'task-1',
    dependencyId: 'acme.cli',
    planId: 'plan-1',
    version: '1.4.0',
    platform: 'darwin',
    arch: 'arm64',
    targetDir: '/home/u/.dsh/tools/acme.cli/1.4.0',
    state: 'running',
    progress: { stage: 'downloading', fraction: 0.5, receivedBytes: 50, totalBytes: 100 },
    startedAt: '2026-10-17T00:00:00.000Z',
    ...overrides,
  }
}

interface FakeRuntime extends ClueRuntimeApi {
  readonly calls: string[]
  dependencies: readonly DependencyStatus[]
  connections: readonly ConnectionStatusProjection[]
  planResult: DependencyInstallPlan
  taskResult: DependencyInstallTask
  /** Projection answered by an explicit connection poll (default: ready). */
  pollResult?: ConnectionStatusProjection
  /** Tasks answered by the next `dependenciesStatus` poll. */
  pollTask?: DependencyInstallTask
  inspectRejects?: Error
  planRejects?: Error
  startRejects?: Error
  setPathRejects?: Error
  connectRejects?: Error
  statusRejects?: Error
}

/** A fake S2 wrapper: records every method call; no process, no network. */
function fakeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  const calls: string[] = []
  const runtime: FakeRuntime = {
    calls,
    dependencies: [dependency()],
    connections: [connection()],
    planResult: plan(),
    taskResult: task(),
    ...overrides,
    dependenciesInspect: async (input) => {
      calls.push(`inspect:${input?.dependencyId ?? '*'}:${input?.refresh === true ? 'refresh' : 'cached'}`)
      if (runtime.inspectRejects !== undefined) throw runtime.inspectRejects
      return runtime.dependencies
    },
    dependenciesPlan: async (dependencyId) => {
      calls.push(`plan:${dependencyId}`)
      if (runtime.planRejects !== undefined) throw runtime.planRejects
      return runtime.planResult
    },
    dependenciesStart: async (dependencyId, planId) => {
      calls.push(`start:${dependencyId}:${planId}`)
      if (runtime.startRejects !== undefined) throw runtime.startRejects
      return runtime.taskResult
    },
    dependenciesStatus: async (dependencyId) => {
      calls.push(`status:${dependencyId ?? '*'}`)
      if (runtime.statusRejects !== undefined) throw runtime.statusRejects
      return runtime.pollTask === undefined ? [] : [runtime.pollTask]
    },
    dependenciesCancel: async (dependencyId, taskId) => {
      calls.push(`cancel:${dependencyId}:${taskId ?? '*'}`)
      return task({ taskId: taskId ?? 'task-1', state: 'cancelled' })
    },
    dependenciesSetPath: async (dependencyId, path) => {
      calls.push(`setPath:${dependencyId}:${path}`)
      if (runtime.setPathRejects !== undefined) throw runtime.setPathRejects
      return dependency({ manualPath: path, resolvedFrom: 'manual', executablePath: path })
    },
    dependenciesClearPath: async (dependencyId) => {
      calls.push(`clearPath:${dependencyId}`)
      return dependency()
    },
    connectionsStatus: async () => {
      calls.push('connectionsStatus')
      return runtime.connections
    },
    connectionsConnect: async (connectionId) => {
      calls.push(`connect:${connectionId}`)
      if (runtime.connectRejects !== undefined) throw runtime.connectRejects
      return connection({
        connectionId,
        authorization: 'authorizing',
        action: 'connect',
        prompt: {
          verificationUrl: 'https://example.test/device',
          userCode: 'ABCD-1234',
          expiresAt: '2026-10-17T00:10:00.000Z',
          qr: { uri: 'acme://device?code=ABCD-1234' },
          instructions: 'Open the URL and enter the code.',
        },
      })
    },
    connectionsPoll: async (connectionId) => {
      calls.push(`poll:${connectionId}`)
      return runtime.pollResult ?? connection({ connectionId })
    },
    connectionsCancel: async (connectionId) => {
      calls.push(`connectionsCancel:${connectionId}`)
      return connection({ connectionId, authorization: 'not-authorized', action: 'connect' })
    },
  }
  return runtime
}

const BASE_PROPS = {
  sourceId: 'acme.docs',
  sourceName: 'Acme Docs',
  dependencyIds: ['acme.cli'],
  connectionId: 'acme.auth',
}

/** Mount the page and flush the mount read's promise chain. */
async function mount(runtime: FakeRuntime, overrides: Partial<Parameters<typeof SourceConfigPage>[0]> = {}): Promise<RenderedRoot> {
  const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime, ...overrides }))
  await act(async () => { await Promise.resolve() })
  return rendered
}

/** Click a button by its visible/accessible text. */
function click(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll<HTMLElement>('button, a')]
    .find(candidate => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label)
  if (button === undefined) throw new Error(`no control labelled "${label}" in ${container.textContent}`)
  act(() => { button.click() })
}

/** Type into an input and fire React's change event. */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('SourceConfigPage dependency section', () => {
  it('shows the actual path, version, compatibility contract and manual path', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ manualPath: '/opt/acme', version: '1.4.0' })] })
    const rendered = await mount(runtime)
    expect(rendered.container.textContent).toContain('CLI dependency')
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    expect(rendered.container.textContent).toContain('1.4.0')
    expect(rendered.container.textContent).toContain('Minimum 1.2.0 · Recommended 1.4.0')
    expect(rendered.container.textContent).toContain('/opt/acme')
    // The mount read is an explicit status request, never a plan/install/login.
    expect(runtime.calls.filter(call => !call.startsWith('inspect:') && !call.startsWith('connectionsStatus'))).toEqual([])
    rendered.unmount()
  })

  it('re-check calls inspect with refresh and never an account request, plan or install', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    runtime.calls.length = 0
    click(rendered.container, 'Recheck')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toEqual(['inspect:acme.cli:refresh', 'connectionsStatus'])
    expect(runtime.calls.some(call => call.startsWith('connect:') || call.startsWith('plan:') || call.startsWith('start:'))).toBe(false)
    rendered.unmount()
  })

  it('offers the one-click install only when the host can install, and keeps manual guidance otherwise', async () => {
    const runtime = fakeRuntime({
      dependencies: [dependency({
        installable: false,
        supported: false,
        manualInstall: { instructions: 'Install the package from your distribution', url: 'https://example.test/manual' },
      })],
    })
    const rendered = await mount(runtime)
    const install = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === 'One-click install')
    expect(install?.disabled).toBe(true)
    expect(rendered.container.textContent).toContain('Automatic install is not available on this platform.')
    expect(rendered.container.textContent).toContain('Install the package from your distribution')
    expect(rendered.container.querySelector('a[href="https://example.test/manual"]')).not.toBeNull()
    rendered.unmount()
  })

  it('validates the manual path before it is submitted, then applies it and reports failure inline', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    const input = rendered.container.querySelector<HTMLInputElement>('input[placeholder="Absolute path to the executable"]')!
    type(input, 'acme')
    click(rendered.container, 'Use path')
    expect(runtime.calls.filter(call => call.startsWith('setPath:'))).toEqual([])
    expect(rendered.container.textContent).toContain('Enter an absolute path')

    runtime.setPathRejects = new Error('the path does not exist')
    type(input, '/nope/acme')
    click(rendered.container, 'Use path')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('setPath:acme.cli:/nope/acme')
    expect(rendered.container.textContent).toContain('the path does not exist')
    // The page and the existing status stay in place after the failure.
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    rendered.unmount()
  })

  it('clears an explicit manual path through the runtime', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ manualPath: '/opt/acme' })] })
    const rendered = await mount(runtime)
    click(rendered.container, 'Clear manual path')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('clearPath:acme.cli')
    rendered.unmount()
  })
})

describe('SourceConfigPage install plan, progress and cancellation', () => {
  it('builds a plan first, shows its actions and target, and starts only after confirmation', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('plan:acme.cli')
    expect(runtime.calls.some(call => call.startsWith('start:'))).toBe(false)
    expect(rendered.container.textContent).toContain('Install plan: Acme CLI 1.4.0')
    expect(rendered.container.textContent).toContain('Install to /home/u/.dsh/tools/acme.cli/1.4.0')
    expect(rendered.container.textContent).toContain('Download the official archive')
    expect(rendered.container.textContent).toContain('Verify SHA-256')

    click(rendered.container, 'Confirm and install')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('start:acme.cli:plan-1')
    expect(rendered.container.textContent).toContain('Downloading')
    expect(rendered.container.querySelector('[role="progressbar"]')).not.toBeNull()
    rendered.unmount()
  })

  it('cancels a plan without starting it', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    click(rendered.container, 'Cancel')
    expect(runtime.calls.some(call => call.startsWith('start:'))).toBe(false)
    expect(rendered.container.textContent).not.toContain('Confirm and install')
    rendered.unmount()
  })

  it('polls the running task to completion and then re-probes the dependency', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      runtime.calls.length = 0
      runtime.pollTask = task({ state: 'succeeded', progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' })
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(runtime.calls).toContain('status:acme.cli')
      expect(rendered.container.textContent).toContain('Done')
      // A settled install re-probes the dependency state (the row is not stale).
      expect(runtime.calls).toContain('inspect:acme.cli:cached')
      // The interval stops once the task settled (advancing more adds no calls).
      const settledCalls = runtime.calls.length
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(runtime.calls).toHaveLength(settledCalls)
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels a running install through the runtime', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    click(rendered.container, 'Confirm and install')
    await act(async () => { await Promise.resolve() })
    click(rendered.container, 'Cancel install')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('cancel:acme.cli:task-1')
    expect(rendered.container.textContent).toContain('Install cancelled')
    rendered.unmount()
  })
})

describe('SourceConfigPage connection and authorization', () => {
  it('shows configuration/authorization and starts authorization only on the explicit click', async () => {
    const runtime = fakeRuntime({
      connections: [connection({ authorization: 'not-authorized', action: 'connect' })],
    })
    const rendered = await mount(runtime)
    expect(rendered.container.textContent).toContain('Connection and authorization')
    expect(rendered.container.textContent).toContain('Not configured')
    expect(runtime.calls.some(call => call.startsWith('connect:'))).toBe(false)

    click(rendered.container, 'Authorize')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('connect:acme.auth')
    // The prompt is the adapter's opaque human payload: URL, code, QR payload.
    expect(rendered.container.textContent).toContain('https://example.test/device')
    expect(rendered.container.textContent).toContain('ABCD-1234')
    expect(rendered.container.textContent).toContain('acme://device?code=ABCD-1234')
    expect(rendered.container.textContent).toContain('Open the URL and enter the code.')
    rendered.unmount()
  })

  it('polls and cancels an in-flight authorization as separate explicit actions', async () => {
    const authorizing = connection({
      authorization: 'authorizing',
      action: 'connect',
      prompt: {
        verificationUrl: 'https://example.test/device',
        userCode: 'ABCD-1234',
        expiresAt: '2026-10-17T00:10:00.000Z',
      },
    })
    const runtime = fakeRuntime({
      connections: [authorizing],
      // Polling keeps the attempt alive: the cancel action must stay reachable.
      pollResult: authorizing,
    })
    const rendered = await mount(runtime)
    click(rendered.container, 'I’m done — check status')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('poll:acme.auth')
    runtime.calls.length = 0
    click(rendered.container, 'Cancel authorization')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('connectionsCancel:acme.auth')
    rendered.unmount()
  })

  it('never renders tokens, raw stdout or secret fields even when a DTO smuggles them in', async () => {
    const smuggledDependency = {
      ...dependency(),
      token: 'ghp_SECRET_TOKEN',
      stdout: 'RAW STDOUT SECRET',
      env: { SECRET: 'ENV SECRET' },
    } as unknown as DependencyStatus
    const smuggledConnection = {
      ...connection({ authorization: 'not-authorized', action: 'connect' }),
      token: 'lark_SECRET_TOKEN',
      stdout: 'CONNECTION STDOUT SECRET',
    } as unknown as ConnectionStatusProjection
    const runtime = fakeRuntime({
      dependencies: [smuggledDependency],
      connections: [smuggledConnection],
    })
    const rendered = await mount(runtime)
    const text = rendered.container.textContent ?? ''
    expect(text).not.toContain('ghp_SECRET_TOKEN')
    expect(text).not.toContain('RAW STDOUT SECRET')
    expect(text).not.toContain('ENV SECRET')
    expect(text).not.toContain('lark_SECRET_TOKEN')
    expect(text).not.toContain('CONNECTION STDOUT SECRET')
    expect(rendered.container.querySelector('[data-clue-secret]')).toBeNull()
    rendered.unmount()
  })

  it('hands a connect failure back to the same page with the settings preserved', async () => {
    const runtime = fakeRuntime({
      connections: [connection({ authorization: 'not-authorized', action: 'connect' })],
      connectRejects: new Error('the authorization request failed'),
    })
    const rendered = await mount(runtime)
    click(rendered.container, 'Authorize')
    await act(async () => { await Promise.resolve() })
    expect(rendered.container.textContent).toContain('the authorization request failed')
    expect(rendered.container.textContent).toContain('Not configured')
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    rendered.unmount()
  })
})
