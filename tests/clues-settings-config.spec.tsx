/**
 * S8 source configuration page (the S6 window body): the primary view keeps
 * the dependency name/status plus the install/recheck actions (and the
 * authorization status/actions), while the executable path, version,
 * compatibility contract and manual override live behind one advanced
 * disclosure. The install plan keeps version/target/source/confirm primary and
 * folds the ordered steps + existing PATH copy. A user-clicked install entry
 * (`initialAction: 'install'`) may auto-PROPOSE the first missing/incompatible
 * dependency's plan, but the explicit confirm → start step is never skipped.
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

import { t } from '../src/client/locales.ts'
import { SourceConfigPage } from '../src/client/clues/settings/config.tsx'
import { subscribeInstallPolling } from '../src/client/clues/settings/install-polling.ts'
import {
  publishClueStatuses,
  publishClueTask,
  subscribeClueRuntime,
} from '../src/client/clues/settings/runtime-state.ts'
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
    systemInstall: { executablePath: '/usr/bin/acme', version: '1.2.0', compatible: false },
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
  /** Tasks answered by `dependenciesStatus` (all latest tasks; filter by id). */
  latestTasks?: DependencyInstallTask[]
  /** Tasks answered by the next `dependenciesStatus` poll (single-task shortcut). */
  pollTask?: DependencyInstallTask
  /** Per-dependency start/plan fixtures (multi-dependency windows). */
  planByDependency?: Record<string, DependencyInstallPlan>
  taskByDependency?: Record<string, DependencyInstallTask>
  inspectRejects?: Error
  planRejects?: Error
  startRejects?: Error
  setPathRejects?: Error
  connectRejects?: Error
  cancelRejects?: Error
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
      return runtime.planByDependency?.[dependencyId] ?? runtime.planResult
    },
    dependenciesStart: async (dependencyId, planId) => {
      calls.push(`start:${dependencyId}:${planId}`)
      if (runtime.startRejects !== undefined) throw runtime.startRejects
      return runtime.taskByDependency?.[dependencyId] ?? runtime.taskResult
    },
    dependenciesStatus: async (dependencyId) => {
      calls.push(`status:${dependencyId ?? '*'}`)
      if (runtime.statusRejects !== undefined) throw runtime.statusRejects
      if (runtime.latestTasks !== undefined) {
        return dependencyId === undefined
          ? runtime.latestTasks
          : runtime.latestTasks.filter(task => task.dependencyId === dependencyId)
      }
      return runtime.pollTask === undefined ? [] : [runtime.pollTask]
    },
    dependenciesCancel: async (dependencyId, taskId) => {
      calls.push(`cancel:${dependencyId}:${taskId ?? '*'}`)
      if (runtime.cancelRejects !== undefined) throw runtime.cancelRejects
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

/** Flush several promise turns through act() (loadAll has chained awaits). */
async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
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

/** The text of the page with every <details> subtree removed (primary view). */
function primaryText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement
  for (const details of clone.querySelectorAll('details')) details.remove()
  return clone.textContent ?? ''
}

/** Open one native disclosure by (part of) its summary text. */
function openDetails(container: HTMLElement, summary: string): HTMLDetailsElement {
  const details = [...container.querySelectorAll<HTMLDetailsElement>('details')]
    .find(candidate => candidate.querySelector('summary')?.textContent?.includes(summary) === true)
  if (details === undefined) throw new Error(`no details "${summary}" in ${container.textContent}`)
  act(() => {
    details.open = true
    details.dispatchEvent(new Event('toggle'))
  })
  return details
}

describe('SourceConfigPage dependency section', () => {
  it('does not claim "not installed" / "not configured" before the first read completes', async () => {
    const runtime = fakeRuntime()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    runtime.dependenciesInspect = async () => { await gate; return runtime.dependencies }
    runtime.connectionsStatus = async () => { await gate; return runtime.connections }
    // Render without flushing the mount read: this is the first frame.
    const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime }))
    const text = rendered.container.textContent ?? ''
    expect(text).toContain('Not checked')
    // A slow/mounting read must not print a terminal missing verdict.
    expect(text).not.toContain('Not installed')
    expect(text).not.toContain('Not configured')
    const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
    expect(row.querySelector('[data-kind="unchecked"]')).not.toBeNull()
    release()
    await flush()
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    expect(rendered.container.textContent).toContain('Ready')
    rendered.unmount()
  })

  it('prioritizes recovery tasks without remounting the path draft or disclosure', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    const firstTask = () => rendered.container.querySelector('[data-clue-config] > section')?.getAttribute('aria-label')
    expect(firstTask()).toBe('Connection and authorization')
    const details = openDetails(rendered.container, 'Actual path')
    const input = rendered.container.querySelector<HTMLInputElement>('input[placeholder="Absolute path to the executable"]')!
    type(input, '/opt/draft')
    runtime.dependencies = [dependency({ state: 'missing' })]
    click(rendered.container, 'Recheck')
    await flush()
    expect(firstTask()).toBe('CLI dependency')
    expect(rendered.container.querySelector('input[placeholder]')).toBe(input)
    expect(input.value).toBe('/opt/draft')
    expect(details.open).toBe(true)
    runtime.dependencies = [dependency()]
    click(rendered.container, 'Recheck')
    await flush()
    expect(firstTask()).toBe('Connection and authorization')
    expect(rendered.container.querySelector('input[placeholder]')).toBe(input)
    expect(details.open).toBe(true)
    rendered.unmount()
  })

  it('keeps healthy application diagnostics closed and opens them after a failed check', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    const details = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-connection-details]')!
    expect(details.open).toBe(false)
    expect(details.querySelector('summary')?.textContent).toContain('Read-only')
    expect(primaryText(rendered.container)).not.toContain('Application configuration')
    runtime.connectionsStatus = async () => { throw new Error('check failed') }
    click(rendered.container, 'Recheck')
    await flush()
    expect(details.open).toBe(true)
    expect(details.textContent).toContain('Last known: Ready')
    rendered.unmount()
  })

  it('shows the actual path, version, compatibility contract and manual path behind one disclosure', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ manualPath: '/opt/acme', version: '1.4.0' })] })
    const rendered = await mount(runtime)
    expect(rendered.container.textContent).toContain('CLI dependency')
    // The window content is a named region, not a bare div with aria-label.
    expect(rendered.container.querySelector('section[data-clue-config="acme.docs"]')?.getAttribute('aria-label'))
      .toBe('Acme Docs')
    // The primary view answers "what is it / is it usable / what can I do";
    // the diagnostics live behind a closed native disclosure.
    const details = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-dependency-details]')!
    expect(details.open).toBe(false)
    expect(primaryText(rendered.container)).toContain('Acme CLI')
    expect(primaryText(rendered.container)).toContain('One-click install')
    expect(primaryText(rendered.container)).not.toContain('/usr/local/bin/acme')
    expect(primaryText(rendered.container)).not.toContain('Minimum 1.2.0 · Recommended 1.4.0')
    openDetails(rendered.container, 'Actual path')
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    expect(rendered.container.textContent).toContain('1.4.0')
    expect(rendered.container.textContent).toContain('Minimum 1.2.0 · Recommended 1.4.0')
    expect(rendered.container.textContent).toContain('/opt/acme')
    // The mount read is an explicit status request, never a plan/install/login.
    expect(runtime.calls.filter(call => !call.startsWith('inspect:')
      && !call.startsWith('connectionsStatus')
      && !call.startsWith('status:'))).toEqual([])
    rendered.unmount()
  })

  it('re-check refreshes dependency and connection reads without account actions, plans or installs', async () => {
    const runtime = fakeRuntime()
    const connections = vi.spyOn(runtime, 'connectionsStatus')
    const rendered = await mount(runtime)
    expect(connections).toHaveBeenLastCalledWith('acme.auth', expect.any(AbortSignal), false)
    runtime.calls.length = 0
    click(rendered.container, 'Recheck')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toEqual(['inspect:acme.cli:refresh', 'connectionsStatus', 'status:*'])
    expect(connections).toHaveBeenLastCalledWith('acme.auth', expect.any(AbortSignal), true)
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
    openDetails(rendered.container, 'Actual path')
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
    // The failure sits on the path row, not in a page-wide banner.
    expect(rendered.container.querySelector('[data-clue-path-error="acme.cli"]')?.textContent)
      .toContain('the path does not exist')
    // The page and the existing status stay in place after the failure.
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    rendered.unmount()
  })

  it('clears an explicit manual path through the runtime', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ manualPath: '/opt/acme' })] })
    const rendered = await mount(runtime)
    openDetails(rendered.container, 'Actual path')
    click(rendered.container, 'Clear manual path')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('clearPath:acme.cli')
    rendered.unmount()
  })

  it('waits for the first status read instead of cancelling it when a path is applied', async () => {
    const runtime = fakeRuntime()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalInspect = runtime.dependenciesInspect
    let gated = false
    runtime.dependenciesInspect = async (input) => {
      if (gated) await gate
      return originalInspect(input)
    }
    gated = true
    const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime }))
    await act(async () => { await Promise.resolve() })
    openDetails(rendered.container, 'Actual path')
    const input = rendered.container.querySelector<HTMLInputElement>(
      'input[placeholder="Absolute path to the executable"]',
    )!
    type(input, '/opt/acme')
    click(rendered.container, 'Use path')
    await act(async () => { await Promise.resolve() })
    // The mount read also covers the connection projection: the write waits
    // for it instead of cancelling the only read that carries that answer.
    expect(runtime.calls.some(call => call.startsWith('setPath:'))).toBe(false)
    release()
    await flush()
    expect(runtime.calls).toContain('setPath:acme.cli:/opt/acme')
    expect(rendered.container.textContent).toContain('/opt/acme')
    rendered.unmount()
  })
})

describe('SourceConfigPage initial install intent', () => {
  it('plans the first missing dependency from a user-clicked install entry, without starting it', async () => {
    const runtime = fakeRuntime({
      dependencies: [dependency({
        state: 'missing',
        version: undefined,
        executablePath: undefined,
      })],
    })
    const rendered = await mount(runtime, { initialAction: 'install' })
    await flush()
    expect(runtime.calls.filter(call => call === 'plan:acme.cli')).toHaveLength(1)
    expect(runtime.calls.some(call => call.startsWith('start:'))).toBe(false)
    // The plan is a proposal: the explicit confirm button is still the only
    // way to start the install task.
    expect(rendered.container.textContent).toContain('Install plan: Acme CLI 1.4.0')
    expect(rendered.container.textContent).toContain('Confirm and install')
    // A later recheck must not replay the one-shot intent.
    click(rendered.container, 'Recheck')
    await flush()
    expect(runtime.calls.filter(call => call === 'plan:acme.cli')).toHaveLength(1)
    rendered.unmount()
  })

  it('does not plan on a regular open or when the dependency is already usable', async () => {
    const missing = fakeRuntime({ dependencies: [dependency({ state: 'missing' })] })
    const regular = await mount(missing)
    await flush()
    expect(missing.calls.some(call => call.startsWith('plan:'))).toBe(false)
    regular.unmount()

    const ready = fakeRuntime()
    const intent = await mount(ready, { initialAction: 'install' })
    await flush()
    expect(ready.calls.some(call => call.startsWith('plan:'))).toBe(false)
    intent.unmount()
  })
})

describe('SourceConfigPage install plan, progress and cancellation', () => {
  it('builds a plan first, keeps the decision primary and folds the steps, then starts only after confirmation', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('plan:acme.cli')
    expect(runtime.calls.some(call => call.startsWith('start:'))).toBe(false)
    // The confirmation decision stays on the main surface: exact version,
    // target, distribution source, platform and expiry.
    expect(primaryText(rendered.container)).toContain('Install plan: Acme CLI 1.4.0')
    expect(primaryText(rendered.container)).toContain('Install to /home/u/.dsh/tools/acme.cli/1.4.0')
    expect(primaryText(rendered.container)).toContain('Platform / architecture')
    expect(primaryText(rendered.container)).toContain('darwin / arm64')
    expect(primaryText(rendered.container)).toContain('Distribution')
    expect(primaryText(rendered.container)).toContain('GitHub releases · Official archive')
    expect(primaryText(rendered.container)).toContain('Plan expires')
    expect(primaryText(rendered.container)).toContain('Confirm and install')
    expect(primaryText(rendered.container)).not.toContain('Download the official archive')
    expect(primaryText(rendered.container)).not.toContain('Existing system install')
    // The ordered steps and the PATH copy are reference material.
    const planDetails = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-plan-details]')!
    expect(planDetails.open).toBe(false)
    openDetails(rendered.container, 'Task detail')
    expect(rendered.container.textContent).toContain('Download the official archive')
    expect(rendered.container.textContent).toContain('Verify SHA-256')
    expect(rendered.container.textContent).toContain('Existing system install')
    expect(rendered.container.textContent).toContain('/usr/bin/acme')
    expect(rendered.container.textContent).toContain('1.2.0 · incompatible')
    expect(rendered.container.textContent).toContain(new Date('2026-10-17T00:10:00.000Z').toLocaleString())
    expect(rendered.container.textContent).not.toContain('{time}')

    click(rendered.container, 'Confirm and install')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('start:acme.cli:plan-1')
    expect(rendered.container.textContent).toContain('Downloading')
    expect(rendered.container.querySelector('[role="progressbar"]')).not.toBeNull()
    // A live task outranks the pre-install dependency DTO: the READY badge
    // must not stay on screen while the install is running.
    expect(rendered.container.querySelector('[data-clue-dependency="acme.cli"] [data-kind]')
      ?.getAttribute('data-kind')).toBe('installing')
    rendered.unmount()
  })

  it('shows why a plan cannot install and whether a PATH copy was detected', async () => {
    const runtime = fakeRuntime({
      planResult: plan({
        installable: false,
        unavailableReason: 'no archive for linux-arm64',
        systemInstall: undefined,
      }),
    })
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    expect(rendered.container.textContent).toContain('Automatic install is not available on this platform.')
    expect(rendered.container.textContent).toContain('no archive for linux-arm64')
    // The PATH-copy diagnostic is reference material behind the plan disclosure.
    expect(primaryText(rendered.container)).not.toContain('None detected')
    openDetails(rendered.container, 'Task detail')
    expect(rendered.container.textContent).toContain('None detected')
    // Nothing can be confirmed: only the cancel action remains.
    expect(rendered.container.textContent).not.toContain('Confirm and install')
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
      expect(runtime.calls).toContain('status:*')
      expect(rendered.container.textContent).toContain('Done')
      // A settled install re-probes the dependency state (the row is not stale).
      expect(runtime.calls).toContain('inspect:acme.cli:refresh')
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

  it('shows unchecked while the post-install probe is in flight, never the pre-install Ready', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      // The settled task triggers a re-probe; hold that probe.
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const originalInspect = runtime.dependenciesInspect
      let gated = false
      runtime.dependenciesInspect = async (input) => {
        if (gated) await gate
        return originalInspect(input)
      }
      gated = true
      runtime.pollTask = task({ state: 'succeeded', progress: { stage: 'completed' } })
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
      expect(row.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('unchecked')
      expect(row.textContent).toContain('Not checked')
      release()
      await flush()
      expect(row.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('ready')
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('SourceConfigPage connection and authorization', () => {
  it('shows configuration/authorization and starts authorization only on the explicit click', async () => {
    const runtime = fakeRuntime({
      connections: [connection({ authorization: 'not-authorized', action: 'connect' })],
    })
    const rendered = await mount(runtime)
    expect(rendered.container.textContent).toContain('Connection and authorization')
    expect(rendered.container.textContent).toContain('Not authorized')
    expect(runtime.calls.some(call => call.startsWith('connect:'))).toBe(false)

    click(rendered.container, 'Authorize')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('connect:acme.auth')
    // The prompt is the adapter's opaque human payload: URL, code, QR payload.
    expect(rendered.container.textContent).toContain('https://example.test/device')
    expect(rendered.container.textContent).toContain('ABCD-1234')
    expect(rendered.container.textContent).toContain('acme://device?code=ABCD-1234')
    expect(rendered.container.textContent).toContain('Open the URL and enter the code.')
    // S4 §31: the SAME opaque URL is encoded as a QR, not just printed.
    const qr = rendered.container.querySelector('[data-clue-qr] svg[role="img"]')
    expect(qr).not.toBeNull()
    expect(qr!.getAttribute('aria-label')).toBe('Authorization QR code')
    expect(qr!.querySelector('path')?.getAttribute('d')?.length ?? 0).toBeGreaterThan(0)
    expect(rendered.container.querySelector('[data-clue-qr]')?.textContent)
      .toContain('acme://device?code=ABCD-1234')
    // The expiry copy carries its {time} parameter at the RENDER site (the
    // dictionary token alone is not enough).
    expect(rendered.container.textContent).not.toContain('{time}')
    expect(rendered.container.textContent).toContain(new Date('2026-10-17T00:10:00.000Z').toLocaleString())
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

  it('marks the connection row request-failed after a failed re-read, even with a previous projection', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    expect(rendered.container.querySelector('[data-authorization="ready"]')).not.toBeNull()
    runtime.connectionsStatus = async () => { throw new Error('the connection status route failed') }
    click(rendered.container, 'Recheck')
    await flush()
    const section = rendered.container.querySelector<HTMLElement>('[aria-label="Connection and authorization"]')!
    expect(section.querySelector('[data-kind="request-failed"]')).not.toBeNull()
    // The old "Ready" is not presented as the current authorization answer.
    expect(section.querySelector('[data-authorization]')).toBeNull()
    expect(section.textContent).toContain('Request failed')
    // The configuration row is stale too: it keeps the old value only as
    // explicitly labelled last-known context, never as the current answer.
    expect(section.querySelector('[data-configuration]')).toBeNull()
    expect(section.querySelectorAll('[data-stale="true"]')).toHaveLength(2)
    expect(section.textContent).toContain('Last known: Ready')
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
    expect(rendered.container.querySelector('[data-clue-connection-action-error]')?.textContent)
      .toContain('the authorization request failed')
    expect(rendered.container.textContent).toContain('Not authorized')
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    rendered.unmount()
  })
})

// ── Failure / retry paths ─────────────────────────────────────────────────

describe('SourceConfigPage failure handling', () => {
  it('keeps the last path/version when a recheck probe fails, and recovers on retry', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ manualPath: '/opt/acme', version: '1.4.0' })] })
    const rendered = await mount(runtime)
    runtime.inspectRejects = new Error('the probe timed out')
    click(rendered.container, 'Recheck')
    await flush()
    expect(rendered.container.textContent).toContain('the probe timed out')
    // The failed probe did not erase the previous observation.
    expect(rendered.container.textContent).toContain('/usr/local/bin/acme')
    expect(rendered.container.textContent).toContain('1.4.0')
    const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
    expect(row.querySelector('[data-kind="request-failed"]')).not.toBeNull()

    runtime.inspectRejects = undefined
    click(rendered.container, 'Recheck')
    await flush()
    expect(row.querySelector('[data-kind="ready"]')).not.toBeNull()
    rendered.unmount()
  })

  it('clears a failed probe after a successful manual path write (no stale request-failed badge)', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    runtime.inspectRejects = new Error('the probe timed out')
    click(rendered.container, 'Recheck')
    await flush()
    const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
    expect(row.querySelector('[data-kind="request-failed"]')).not.toBeNull()

    runtime.inspectRejects = undefined
    openDetails(rendered.container, 'Actual path')
    const input = rendered.container.querySelector<HTMLInputElement>('input[placeholder="Absolute path to the executable"]')!
    type(input, '/opt/acme')
    click(rendered.container, 'Use path')
    await flush()
    // The successful path write is a fresh observation: the old probe failure
    // must not keep winning over the new DTO.
    expect(row.querySelector('[data-kind="request-failed"]')).toBeNull()
    expect(row.querySelector('[data-kind="ready"]')).not.toBeNull()
    expect(row.textContent).toContain('/opt/acme')
    rendered.unmount()
  })

  it('shows a failed dependency DTO error inline instead of only a badge', async () => {
    const runtime = fakeRuntime({
      dependencies: [dependency({
        state: 'failed',
        error: { category: 'failed', message: 'the executable exited with 3' },
      })],
    })
    const rendered = await mount(runtime)
    expect(rendered.container.textContent).toContain('the executable exited with 3')
    rendered.unmount()
  })

  it('reports plan/start failures inline and keeps the page usable', async () => {
    const planRuntime = fakeRuntime({ planRejects: new Error('no verified release for this platform') })
    const planned = await mount(planRuntime)
    click(planned.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    expect(planned.container.textContent).toContain('no verified release for this platform')
    expect(planned.container.querySelector('[data-clue-dependency-action-error="acme.cli"]')?.textContent)
      .toContain('no verified release for this platform')
    expect(planned.container.textContent).not.toContain('Confirm and install')
    planned.unmount()

    const startRuntime = fakeRuntime({ startRejects: new Error('the installer refused to start') })
    const started = await mount(startRuntime)
    click(started.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    click(started.container, 'Confirm and install')
    await act(async () => { await Promise.resolve() })
    expect(started.container.textContent).toContain('the installer refused to start')
    expect(started.container.querySelector('[role="progressbar"]')).toBeNull()
    // The plan stays on screen so the user can retry without rebuilding it.
    expect(started.container.textContent).toContain('Confirm and install')
    started.unmount()
  })

  it('reports a failed connection status read as request-failed and offers a retry (connection-only source)', async () => {
    const runtime = fakeRuntime({
      connections: [connection({ authorization: 'not-authorized', action: 'connect' })],
    })
    runtime.connectionsStatus = async () => {
      runtime.calls.push('connectionsStatus')
      throw new Error('the connection status route failed')
    }
    const rendered = await mount(runtime, { dependencyIds: [] })
    expect(rendered.container.textContent).toContain('the connection status route failed')
    expect(rendered.container.textContent).toContain('Request failed')
    // A failed READ is not "never configured".
    expect(rendered.container.textContent).not.toContain('Not configured')
    const recheck = [...rendered.container.querySelectorAll('button')]
      .find(button => button.textContent?.trim() === 'Recheck')
    expect(recheck).toBeDefined()

    runtime.connectionsStatus = async () => {
      runtime.calls.push('connectionsStatus')
      return [connection({ authorization: 'not-authorized', action: 'connect' })]
    }
    click(rendered.container, 'Recheck')
    await act(async () => { await Promise.resolve() })
    expect(rendered.container.textContent).toContain('Not authorized')
    expect(rendered.container.textContent).not.toContain('Request failed')
    rendered.unmount()
  })
})

// ── Install task polling / multi-view sharing ─────────────────────────────

describe('SourceConfigPage install task polling', () => {
  it('stops polling when the runtime no longer reports the remembered task', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      expect(rendered.container.querySelector('[role="progressbar"]')).not.toBeNull()
      runtime.calls.length = 0
      // dependenciesStatus answers [] (the task vanished).
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(runtime.calls).toContain('status:*')
      expect(rendered.container.querySelector('[role="progressbar"]')).toBeNull()
      // The loop settled instead of asking every second forever.
      const settled = runtime.calls.filter(call => call === 'status:*').length
      expect(settled).toBe(1)
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(runtime.calls.filter(call => call === 'status:*')).toHaveLength(settled)
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up after repeated status failures instead of spinning at 1 Hz', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime({ statusRejects: new Error('the status route is down') })
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      runtime.calls.length = 0
      for (let index = 0; index < 3; index += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      }
      expect(rendered.container.textContent).toContain('the status route is down')
      expect(runtime.calls.filter(call => call === 'status:*')).toHaveLength(3)
      expect(rendered.container.querySelector('[role="progressbar"]')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
      expect(runtime.calls.filter(call => call === 'status:*')).toHaveLength(3)
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears a transient status-poll failure when the next poll succeeds', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      runtime.statusRejects = new Error('the status route is temporarily down')
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(rendered.container.textContent).toContain('the status route is temporarily down')
      // The failure is on the dependency row (the page-level banner is only
      // for read failures), so it is visible next to the progress row.
      expect(rendered.container.querySelector('[data-clue-poll-error="acme.cli"]')?.textContent)
        .toContain('the status route is temporarily down')
      // The next poll recovers: the row's error must go away (the old page
      // banner never did, and could outlive the failure).
      runtime.statusRejects = undefined
      runtime.pollTask = task({
        state: 'succeeded',
        progress: { stage: 'completed' },
        finishedAt: '2026-10-17T00:01:00.000Z',
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(rendered.container.textContent).not.toContain('the status route is temporarily down')
      expect(rendered.container.querySelector('[data-clue-poll-error]')).toBeNull()
      expect(rendered.container.querySelector('[role="progressbar"]')).toBeNull()
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('polls EVERY running dependency, not just one', async () => {
    vi.useFakeTimers()
    try {
      const other = dependency({ dependencyId: 'other.cli', name: 'Other CLI', command: 'other' })
      const runtime = fakeRuntime({
        dependencies: [dependency(), other],
        planByDependency: {
          'other.cli': plan({ planId: 'plan-2', dependencyId: 'other.cli', name: 'Other CLI' }),
        },
        taskByDependency: {
          'other.cli': task({ taskId: 'task-2', dependencyId: 'other.cli', planId: 'plan-2' }),
        },
      })
      const rendered = await mount(runtime, { dependencyIds: ['acme.cli', 'other.cli'] })
      const clickIn = (dependencyId: string, label: string): void => {
        const row = rendered.container.querySelector(`[data-clue-dependency="${dependencyId}"]`)!
        const button = [...row.querySelectorAll<HTMLElement>('button')]
          .find(candidate => candidate.textContent?.trim() === label)
        if (button === undefined) throw new Error(`no "${label}" in ${dependencyId}`)
        act(() => { button.click() })
      }
      clickIn('acme.cli', 'One-click install')
      await act(async () => { await Promise.resolve() })
      clickIn('acme.cli', 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      clickIn('other.cli', 'One-click install')
      await act(async () => { await Promise.resolve() })
      clickIn('other.cli', 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      expect(rendered.container.querySelectorAll('[role="progressbar"]')).toHaveLength(2)
      runtime.latestTasks = [task(), task({ taskId: 'task-2', dependencyId: 'other.cli', planId: 'plan-2' })]
      runtime.calls.length = 0
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      // One shared poller asks for the whole task list once, not once per
      // dependency or per window.
      expect(runtime.calls.filter(call => call === 'status:*')).toHaveLength(1)
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-reads every dependency when two tasks settle in the same tick', async () => {
    vi.useFakeTimers()
    try {
      const other = dependency({ dependencyId: 'other.cli', name: 'Other CLI', command: 'other' })
      const runtime = fakeRuntime({
        dependencies: [dependency(), other],
        planByDependency: {
          'other.cli': plan({ planId: 'plan-2', dependencyId: 'other.cli', name: 'Other CLI' }),
        },
        taskByDependency: {
          'other.cli': task({ taskId: 'task-2', dependencyId: 'other.cli', planId: 'plan-2' }),
        },
      })
      const rendered = await mount(runtime, { dependencyIds: ['acme.cli', 'other.cli'] })
      const clickIn = (dependencyId: string, label: string): void => {
        const row = rendered.container.querySelector(`[data-clue-dependency="${dependencyId}"]`)!
        const button = [...row.querySelectorAll<HTMLElement>('button')]
          .find(candidate => candidate.textContent?.trim() === label)
        if (button === undefined) throw new Error(`no "${label}" in ${dependencyId}`)
        act(() => { button.click() })
      }
      clickIn('acme.cli', 'One-click install')
      await act(async () => { await Promise.resolve() })
      clickIn('acme.cli', 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      clickIn('other.cli', 'One-click install')
      await act(async () => { await Promise.resolve() })
      clickIn('other.cli', 'Confirm and install')
      await act(async () => { await Promise.resolve() })

      const fresh = new Map([
        ['acme.cli', dependency({ version: '2.0.0', executablePath: '/opt/acme/2.0.0/bin/acme' })],
        ['other.cli', dependency({
          dependencyId: 'other.cli',
          name: 'Other CLI',
          command: 'other',
          version: '3.0.0',
          executablePath: '/opt/other/3.0.0/bin/other',
        })],
      ])
      const reRead: string[] = []
      runtime.dependenciesInspect = async (input) => {
        const dependencyId = input?.dependencyId ?? ''
        reRead.push(dependencyId)
        const item = fresh.get(dependencyId)
        return item === undefined ? [] : [item]
      }
      runtime.latestTasks = [
        task({
          taskId: 'task-1',
          dependencyId: 'acme.cli',
          planId: 'plan-1',
          state: 'succeeded',
          progress: { stage: 'completed' },
          finishedAt: '2026-10-17T00:01:00.000Z',
        }),
        task({
          taskId: 'task-2',
          dependencyId: 'other.cli',
          planId: 'plan-2',
          state: 'succeeded',
          progress: { stage: 'completed' },
          finishedAt: '2026-10-17T00:01:00.000Z',
        }),
      ]
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      await flush()

      // BOTH settled dependencies were re-read: the first batch's mutation
      // fence must not invalidate the second dependency's probe.
      expect(new Set(reRead)).toEqual(new Set(['acme.cli', 'other.cli']))
      for (const [dependencyId, item] of fresh) {
        const row = rendered.container.querySelector(`[data-clue-dependency="${dependencyId}"]`)!
        expect(row.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('ready')
        expect(row.textContent).toContain(item.version!)
        expect(row.textContent).toContain(item.executablePath!)
      }
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('two configuration windows share ONE status poll per tick', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const first = await mount(runtime)
      click(first.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(first.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      runtime.latestTasks = [task()]
      const second = await mount(runtime)
      expect(second.container.querySelector('[role="progressbar"]')).not.toBeNull()
      runtime.calls.length = 0
      runtime.latestTasks = [task({
        state: 'succeeded',
        progress: { stage: 'completed' },
        finishedAt: '2026-10-17T00:01:00.000Z',
      })]
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      // One timer for the shared runtime face, one request for both windows.
      expect(runtime.calls.filter(call => call === 'status:*')).toHaveLength(1)
      expect(first.container.textContent).toContain('Done')
      expect(second.container.textContent).toContain('Done')
      first.unmount()
      second.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a recovered poll clears only the poll error, never a cancel failure', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      runtime.pollTask = task()
      runtime.cancelRejects = new Error('the cancel route is down')
      click(rendered.container, 'Cancel install')
      await act(async () => { await Promise.resolve() })
      const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
      expect(row.querySelector('[data-clue-dependency-action-error="acme.cli"]')?.textContent)
        .toContain('the cancel route is down')
      // The next poll succeeds (the task is still running elsewhere): it may
      // clear its own transient error, but the cancel failure is a different
      // answer and must stay on the row.
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(row.querySelector('[data-clue-poll-error]')).toBeNull()
      expect(row.querySelector('[data-clue-dependency-action-error="acme.cli"]')?.textContent)
        .toContain('the cancel route is down')
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an in-flight Recheck cannot overwrite a successful manual path write', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalInspect = runtime.dependenciesInspect
    let gated = false
    runtime.dependenciesInspect = async (input) => {
      if (gated) await gate
      return originalInspect(input)
    }
    gated = true
    click(rendered.container, 'Recheck')
    await act(async () => { await Promise.resolve() })
    openDetails(rendered.container, 'Actual path')
    // The old read is still waiting; the user's explicit write settles first.
    const input = rendered.container.querySelector<HTMLInputElement>(
      'input[placeholder="Absolute path to the executable"]',
    )!
    type(input, '/opt/acme')
    click(rendered.container, 'Use path')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('setPath:acme.cli:/opt/acme')
    expect(rendered.container.textContent).toContain('/opt/acme')
    release()
    await flush()
    // The stale projection (the original PATH copy, no manual path) lost.
    expect(rendered.container.textContent).toContain('/opt/acme')
    const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
    expect(row.textContent).toContain('/opt/acme')
    rendered.unmount()
  })

  it('adopts a task started elsewhere (multi-view shared install state)', async () => {
    const runtime = fakeRuntime()
    const first = await mount(runtime)
    click(first.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    runtime.latestTasks = [task()]
    click(first.container, 'Confirm and install')
    await act(async () => { await Promise.resolve() })

    // A second window opened after the install started sees the live task and
    // can cancel it without having started it itself.
    const second = await mount(runtime)
    expect(second.container.querySelector('[role="progressbar"]')).not.toBeNull()
    expect(second.container.textContent).toContain('Cancel install')
    click(second.container, 'Cancel install')
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls).toContain('cancel:acme.cli:task-1')
    expect(second.container.textContent).toContain('Install cancelled')
    // The view that started it observes the cancellation too.
    expect(first.container.textContent).toContain('Install cancelled')
    first.unmount()
    second.unmount()
  })
})

describe('SourceConfigPage cross-window observation fencing', () => {
  it('a status observation from another view invalidates an in-flight read and the read does not republish its old answer', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    const seen: DependencyStatus[][] = []
    const unsubscribe = subscribeClueRuntime(runtime, observation => {
      if (observation.kind === 'statuses') seen.push([...observation.dependencies])
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalInspect = runtime.dependenciesInspect
    let gated = false
    runtime.dependenciesInspect = async (input) => {
      if (gated) await gate
      return originalInspect(input)
    }
    gated = true
    seen.length = 0
    click(rendered.container, 'Recheck')
    await act(async () => { await Promise.resolve() })
    // Another configuration window observed the user's fresh manual path
    // while this window's Recheck is still probing.
    act(() => {
      publishClueStatuses(runtime, [dependency({
        manualPath: '/opt/acme',
        executablePath: '/opt/acme',
        resolvedFrom: 'manual',
      })])
    })
    expect(rendered.container.textContent).toContain('/opt/acme')
    release()
    await flush()
    const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
    expect(row.textContent).toContain('/opt/acme')
    expect(row.textContent).not.toContain('/usr/local/bin/acme')
    // The superseded read must not be published back on the shared bus: that
    // is what used to roll the OTHER window back to the old path.
    expect(seen.some(batch => batch.some(item => item.executablePath === '/usr/local/bin/acme'))).toBe(false)
    unsubscribe()
    rendered.unmount()
  })

  it('a newer authorization observation is not rolled back by an older connection read', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect' })] })
    const rendered = await mount(runtime)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStatus = runtime.connectionsStatus
    let gated = false
    runtime.connectionsStatus = async (...args) => {
      if (gated) await gate
      return originalStatus(...args)
    }
    gated = true
    click(rendered.container, 'Recheck')
    await act(async () => { await Promise.resolve() })
    act(() => {
      publishClueStatuses(runtime, [], [connection({
        authorization: 'authorizing',
        action: 'none',
        prompt: {
          verificationUrl: 'https://example.test/fresh-auth',
          expiresAt: '2026-10-17T00:20:00.000Z',
        },
      })])
    })
    expect(rendered.container.textContent).toContain('https://example.test/fresh-auth')
    release()
    await flush()
    // The stale connection read (ready, no prompt) lost: the other window's
    // newer prompt is still the truth.
    expect(rendered.container.textContent).toContain('https://example.test/fresh-auth')
    rendered.unmount()
  })

  it('a same-dependency task observation during the mount read does not discard the connection projection', async () => {
    const runtime = fakeRuntime()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStatus = runtime.connectionsStatus
    let gated = false
    let connectionRequested = false
    runtime.connectionsStatus = async (...args) => {
      connectionRequested = true
      if (gated) await gate
      return originalStatus(...args)
    }
    gated = true
    const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime }))
    await flush(6)
    // The dependency half has answered; the connection read is still waiting.
    expect(connectionRequested).toBe(true)
    // The shared poller of another view observes a RUNNING task for the SAME
    // dependency while this mount read awaits its connection projection.
    act(() => { publishClueTask(runtime, task()) })
    release()
    await flush()
    const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
    // The live task remains the row's freshest state...
    expect(row.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('installing')
    // ...and the connection projection is NOT discarded with the superseded
    // dependency half of the aggregate read.
    expect(rendered.container.querySelector('[data-authorization]')?.getAttribute('data-authorization'))
      .toBe('ready')
    rendered.unmount()
  })

  it('an unrelated dependency observation does not cancel an in-flight explicit read', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalInspect = runtime.dependenciesInspect
    let gated = false
    runtime.dependencies = [dependency({ version: '5.0.0', executablePath: '/opt/acme-5' })]
    runtime.dependenciesInspect = async (input) => {
      if (gated) await gate
      return originalInspect(input)
    }
    gated = true
    click(rendered.container, 'Recheck')
    await act(async () => { await Promise.resolve() })
    // Another window observed a DIFFERENT dependency while this Recheck was
    // probing. It is not this page's answer and must not discard the read.
    act(() => {
      publishClueStatuses(runtime, [dependency({
        dependencyId: 'other.cli',
        name: 'Other CLI',
        command: 'other',
        state: 'missing',
      })])
    })
    release()
    await flush()
    const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
    expect(row.textContent).toContain('/opt/acme-5')
    expect(row.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('ready')
    rendered.unmount()
  })

  it('re-reads a dependency whose probe a same-dependency observation superseded', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })

      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const originalInspect = runtime.dependenciesInspect
      let calls = 0
      runtime.dependencies = [dependency({ version: '2.0.0', executablePath: '/opt/acme-2' })]
      runtime.dependenciesInspect = async (input) => {
        calls += 1
        if (calls === 1) await gate
        return originalInspect(input)
      }
      runtime.pollTask = task({
        state: 'succeeded',
        progress: { stage: 'completed' },
        finishedAt: '2026-10-17T00:01:00.000Z',
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      expect(calls).toBe(1)
      // Another window publishes ITS answer for the SAME dependency while the
      // post-install probe is in flight: that probe is superseded, not wrong.
      act(() => {
        publishClueStatuses(runtime, [dependency({
          version: '1.4.0',
          executablePath: '/usr/local/bin/acme',
        })])
      })
      release()
      await flush()
      // The superseded probe is re-done once instead of being dropped.
      expect(calls).toBe(2)
      const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
      expect(row.textContent).toContain('/opt/acme-2')
      expect(row.textContent).not.toContain('/usr/local/bin/acme')
      expect(row.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('ready')
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows a failed post-install re-probe on the row instead of swallowing it', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      const rendered = await mount(runtime)
      click(rendered.container, 'One-click install')
      await act(async () => { await Promise.resolve() })
      click(rendered.container, 'Confirm and install')
      await act(async () => { await Promise.resolve() })
      // The mount read succeeded; only the post-install re-probe fails.
      runtime.dependenciesInspect = async () => { throw new Error('the dependency probe is down') }
      runtime.pollTask = task({
        state: 'succeeded',
        progress: { stage: 'completed' },
        finishedAt: '2026-10-17T00:01:00.000Z',
      })
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      await flush()
      const row = rendered.container.querySelector('[data-clue-dependency="acme.cli"]')!
      expect(row.querySelector('[data-kind]')?.getAttribute('data-kind')).toBe('request-failed')
      expect(row.querySelector('[data-clue-poll-error="acme.cli"]')?.textContent)
        .toContain('the dependency probe is down')
      // The last observed path/version is kept, not blanked by the failure.
      expect(row.textContent).toContain('/usr/local/bin/acme')
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('an older task-adoption read cannot resurrect a task another view already settled', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    runtime.latestTasks = [task()]
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStatus = runtime.dependenciesStatus
    let gated = false
    runtime.dependenciesStatus = async (...args) => {
      if (gated) await gate
      return originalStatus(...args)
    }
    gated = true
    click(rendered.container, 'Recheck')
    await flush()
    // The other window observed the terminal state while the adoption read
    // (which will answer with the older RUNNING task) is still in flight.
    act(() => {
      publishClueTask(runtime, task({
        state: 'succeeded',
        progress: { stage: 'completed' },
        finishedAt: '2026-10-17T00:01:00.000Z',
      }))
    })
    expect(rendered.container.textContent).toContain('Done')
    release()
    await flush()
    expect(rendered.container.querySelector('[role="progressbar"]')).toBeNull()
    expect(rendered.container.textContent).toContain('Done')
    rendered.unmount()
  })
})

describe('SourceConfigPage install action gating', () => {
  it('confirming twice sends exactly one start and disables the button while it runs', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStart = runtime.dependenciesStart
    runtime.dependenciesStart = async (...args) => {
      const result = await originalStart(...args)
      await gate
      return result
    }
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Confirm and install')!
    act(() => {
      confirm.click()
      confirm.click()
    })
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls.filter(call => call.startsWith('start:'))).toHaveLength(1)
    expect(confirm.disabled).toBe(true)
    release()
    await flush()
    expect(rendered.container.querySelector('[role="progressbar"]')).not.toBeNull()
    rendered.unmount()
  })

  it('disables one-click install while a task for that dependency is running', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    click(rendered.container, 'Confirm and install')
    await act(async () => { await Promise.resolve() })
    const install = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'One-click install')!
    expect(install.disabled).toBe(true)
    // The same row can still cancel the live task.
    expect(rendered.container.textContent).toContain('Cancel install')
    rendered.unmount()
  })

  it('cancelling twice sends exactly one cancel and disables the button while it runs', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    click(rendered.container, 'One-click install')
    await act(async () => { await Promise.resolve() })
    click(rendered.container, 'Confirm and install')
    await act(async () => { await Promise.resolve() })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalCancel = runtime.dependenciesCancel
    runtime.dependenciesCancel = async (...args) => {
      const result = await originalCancel(...args)
      await gate
      return result
    }
    const cancel = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Cancel install')!
    act(() => {
      cancel.click()
      cancel.click()
    })
    await act(async () => { await Promise.resolve() })
    expect(runtime.calls.filter(call => call.startsWith('cancel:'))).toHaveLength(1)
    expect(cancel.disabled).toBe(true)
    release()
    await flush()
    expect(rendered.container.textContent).toContain('Install cancelled')
    rendered.unmount()
  })

  it('aborts the in-flight mount read when the window closes', async () => {
    const runtime = fakeRuntime()
    let signal: AbortSignal | undefined
    runtime.dependenciesInspect = async (_input, nextSignal) => {
      signal = nextSignal
      return new Promise<readonly DependencyStatus[]>(() => {})
    }
    const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime }))
    await act(async () => { await Promise.resolve() })
    expect(signal).toBeDefined()
    rendered.unmount()
    expect(signal?.aborted).toBe(true)
  })
})

describe('shared install poller steady state', () => {
  /** Flush pending microtasks outside React's act(). */
  const settle = async (turns = 6): Promise<void> => {
    for (let index = 0; index < turns; index += 1) await Promise.resolve()
  }

  it('a subscriber arriving during an in-flight tick cannot start a concurrent status request', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime()
      let calls = 0
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      runtime.dependenciesStatus = async () => {
        calls += 1
        if (calls === 1) await gate
        return []
      }
      const first = subscribeInstallPolling(runtime, () => {})
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toBe(1)
      // The second window opens while the first request is still awaiting.
      const second = subscribeInstallPolling(runtime, () => {})
      await vi.advanceTimersByTimeAsync(1000)
      // No second timer may fire: at most one request in flight.
      expect(calls).toBe(1)
      release()
      await settle()
      await vi.advanceTimersByTimeAsync(1000)
      expect(calls).toBe(2)
      first()
      second()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops while the document is hidden and runs one catch-up tick when visible again', async () => {
    vi.useFakeTimers()
    let hidden = false
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    })
    try {
      const runtime = fakeRuntime()
      let calls = 0
      runtime.dependenciesStatus = async () => {
        calls += 1
        return []
      }
      const off = subscribeInstallPolling(runtime, () => {})
      hidden = true
      document.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(5000)
      expect(calls).toBe(0)
      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      await settle()
      expect(calls).toBe(1)
      off()
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState
      vi.useRealTimers()
    }
  })
})


describe('explicit Feishu permission selection', () => {
  const choices = ['docs.read', 'docs.search', 'docs.edit', 'wiki.read', 'tasks.read', 'tasks.edit']
  function permission(container: HTMLElement, key: Parameters<typeof t>[0]): HTMLInputElement {
    const label = [...container.querySelectorAll('label')].find(node => node.textContent?.trim() === t(key))
    const input = label?.querySelector<HTMLInputElement>('input[type="checkbox"]')
    if (input === null || input === undefined) throw new Error(`No permission checkbox ${key}`)
    return input
  }

  it('defaults docs to read/search, posts a user-selected edit grant and freezes choices during authorization', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect', capabilities: [], selectableCapabilities: choices })] })
    let complete!: (value: ConnectionStatusProjection) => void
    const connect = vi.fn<ClueRuntimeApi['connectionsConnect']>(() => new Promise(resolve => { complete = resolve }))
    runtime.connectionsConnect = connect
    const rendered = await mount(runtime, { sourceId: 'builtin.feishu.docs' })
    await flush()
    const disclosure = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-permissions]')!
    expect(disclosure.open).toBe(false)
    expect(disclosure.querySelector('summary')?.textContent).toContain(t('clueAuthPermissionDocsRead'))
    expect(disclosure.querySelector('summary')?.textContent).not.toContain(t('clueAuthPermissionDocsEdit'))
    openDetails(rendered.container, t('clueAuthPermissions'))
    expect(permission(rendered.container, 'clueAuthPermissionDocsRead').checked).toBe(true)
    expect(permission(rendered.container, 'clueAuthPermissionDocsSearch').checked).toBe(true)
    expect(permission(rendered.container, 'clueAuthPermissionDocsEdit').checked).toBe(false)
    expect(permission(rendered.container, 'clueAuthPermissionTasksRead').checked).toBe(false)
    expect(permission(rendered.container, 'clueAuthPermissionWikiRead').checked).toBe(false)
    act(() => permission(rendered.container, 'clueAuthPermissionDocsEdit').click())
    expect(disclosure.querySelector('summary')?.textContent).toContain(t('clueAuthPermissionDocsEdit'))
    click(rendered.container, 'Authorize')
    expect(connect.mock.calls[0]?.[2]).toEqual(['docs.read', 'docs.search', 'docs.edit'])
    expect(rendered.container.querySelector('fieldset')?.disabled).toBe(true)
    await act(async () => { complete(connection({ authorization: 'authorizing', selectableCapabilities: choices })); await Promise.resolve() })
    expect(rendered.container.querySelector('fieldset')?.disabled).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })

  it('restores the exact requested permissions after closing and reopening configuration', async () => {
    let saved: readonly string[] | undefined
    const permissionPreferences = {
      load: async () => saved,
      save: async (_connectionId: string, capabilities: readonly string[]) => { saved = [...capabilities] },
    }
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'ready', capabilities: ['docs.read'], selectableCapabilities: choices })] })
    const first = await mount(runtime, { sourceId: 'builtin.feishu.docs', permissionPreferences })
    await flush()
    openDetails(first.container, t('clueAuthPermissions'))
    act(() => permission(first.container, 'clueAuthPermissionDocsEdit').click())
    await flush()
    expect(saved).toEqual(['docs.read', 'docs.search', 'docs.comments.read', 'docs.edit'])
    first.unmount()

    const reopened = await mount(runtime, { sourceId: 'builtin.feishu.docs', permissionPreferences })
    await flush()
    openDetails(reopened.container, t('clueAuthPermissions'))
    expect(permission(reopened.container, 'clueAuthPermissionDocsEdit').checked).toBe(true)
    expect(permission(reopened.container, 'clueAuthPermissionDocsSearch').checked).toBe(true)
    expect(reopened.container.querySelector('[data-clue-granted-permissions]')).not.toBeNull()
    reopened.unmount()
  })

  it('defaults tasks to task read only and cannot submit an empty selection', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect', capabilities: [], selectableCapabilities: choices })] })
    const connect = vi.fn<ClueRuntimeApi['connectionsConnect']>(async () => connection({ authorization: 'authorizing', selectableCapabilities: choices }))
    runtime.connectionsConnect = connect
    const rendered = await mount(runtime, { sourceId: 'builtin.feishu.tasks' })
    await flush()
    expect(permission(rendered.container, 'clueAuthPermissionTasksRead').checked).toBe(true)
    expect(permission(rendered.container, 'clueAuthPermissionDocsRead').checked).toBe(false)
    expect(permission(rendered.container, 'clueAuthPermissionTasksEdit').checked).toBe(false)
    act(() => permission(rendered.container, 'clueAuthPermissionTasksRead').click())
    const authorize = [...rendered.container.querySelectorAll('button')].find(node => node.textContent === 'Authorize')!
    expect(authorize.disabled).toBe(true)
    act(() => authorize.click())
    expect(connect).not.toHaveBeenCalled()
    act(() => permission(rendered.container, 'clueAuthPermissionTasksRead').click())
    click(rendered.container, 'Authorize')
    await flush()
    expect(connect.mock.calls[0]?.[2]).toEqual(['tasks.read'])
    rendered.unmount()
  })
})

describe('device-code auto-check', () => {
  const authorizing = (pollAfterMs?: number) => connection({
    authorization: 'authorizing',
    action: 'connect',
    capabilities: [],
    prompt: {
      verificationUrl: 'https://example.test/device',
      userCode: 'ABCD-1234',
      expiresAt: '2026-10-17T00:10:00.000Z',
      ...(pollAfterMs === undefined ? {} : { pollAfterMs }),
    },
  })

  it('re-sends the explicit poll at the CLI cadence and stops at the terminal answer', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime({ connections: [authorizing(1500)] })
      runtime.connectionsPoll = async (connectionId) => {
        runtime.calls.push(`poll:${connectionId}`)
        return connection({ connectionId, authorization: 'ready', action: 'none' })
      }
      const rendered = await mount(runtime)
      runtime.calls.length = 0
      // The hint is honoured: one millisecond short of it nothing is asked.
      await act(async () => { await vi.advanceTimersByTimeAsync(1499) })
      expect(runtime.calls).toEqual([])
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(runtime.calls).toEqual(['poll:acme.auth'])
      await flush()
      expect(rendered.container.textContent).toContain('Ready')
      // A terminal answer ends the wait: no further poll, and the manual
      // fallback is gone because the attempt is over.
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(runtime.calls).toEqual(['poll:acme.auth'])
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('pauses while the page is hidden and re-arms when it is visible again', async () => {
    vi.useFakeTimers()
    let hidden = false
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (hidden ? 'hidden' : 'visible'),
    })
    try {
      const runtime = fakeRuntime({ connections: [authorizing(2000)], pollResult: authorizing(2000) })
      const rendered = await mount(runtime)
      runtime.calls.length = 0
      hidden = true
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
      expect(runtime.calls).toEqual([])
      hidden = false
      act(() => { document.dispatchEvent(new Event('visibilitychange')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
      expect(runtime.calls).toEqual(['poll:acme.auth'])
      rendered.unmount()
    } finally {
      delete (document as unknown as { visibilityState?: unknown }).visibilityState
      vi.useRealTimers()
    }
  })

  it('falls back to the manual button after three consecutive failures', async () => {
    vi.useFakeTimers()
    try {
      const runtime = fakeRuntime({ connections: [authorizing()] })
      runtime.connectionsPoll = async () => {
        runtime.calls.push('poll')
        throw new Error('device check failed')
      }
      const rendered = await mount(runtime)
      runtime.calls.length = 0
      // The default cadence is the device flow's documented 5 s. Each settled
      // failure re-arms the timer from its own render, so advance per round.
      for (let round = 0; round < 3; round += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
      }
      expect(runtime.calls).toEqual(['poll', 'poll', 'poll'])
      await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
      expect(runtime.calls).toEqual(['poll', 'poll', 'poll'])
      // The attempt is still live, so the reader keeps the explicit escape.
      click(rendered.container, 'I’m done — check status')
      await act(async () => { await Promise.resolve() })
      expect(runtime.calls).toHaveLength(4)
      rendered.unmount()
    } finally {
      vi.useRealTimers()
    }
  })
})
