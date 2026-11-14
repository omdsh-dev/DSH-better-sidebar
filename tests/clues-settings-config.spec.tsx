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
beforeAll(() => { Object.defineProperty(navigator, 'language', { value: 'en-US', configurable: true }) })
import { t } from '../src/client/locales.ts'
import { SourceConfigPage } from '../src/client/clues/settings/config.tsx'
import { subscribeInstallPolling } from '../src/client/clues/settings/install-polling.ts'
import {
  publishClueStatuses, publishClueTask, subscribeClueRuntime,
} from '../src/client/clues/settings/runtime-state.ts'
import type { ClueRuntimeApi } from '../src/client/clues/runtime-api.ts'
import type { ConnectionStatusProjection, DependencyInstallPlan, DependencyInstallTask, DependencyStatus } from '../src/clues/runtime/types.ts'
function dependency(overrides: Partial<DependencyStatus> = {}): DependencyStatus {
  return { dependencyId: 'acme.cli', name: 'Acme CLI', command: 'acme', state: 'ready', platform: 'darwin',
    arch: 'arm64', supported: true, installable: true, minimumVersion: '1.2.0', recommendedVersion: '1.4.0',
    version: '1.4.0', executablePath: '/usr/local/bin/acme', resolvedFrom: 'path',
    lastCheckedAt: '2026-10-17T00:00:00.000Z', ...overrides }
}
function connection(overrides: Partial<ConnectionStatusProjection> = {}): ConnectionStatusProjection {
  return { connectionId: 'acme.auth', name: 'Acme Auth', pluginId: 'test.plugin', configuration: 'ready',
    authorization: 'ready', credentialOwner: 'tool', capabilities: ['docs.read'], action: 'none',
    lastCheckedAt: '2026-10-17T00:00:00.000Z', ...overrides }
}
function plan(overrides: Partial<DependencyInstallPlan> = {}): DependencyInstallPlan {
  return { planId: 'plan-1', dependencyId: 'acme.cli', name: 'Acme CLI', command: 'acme', version: '1.4.0',
    platform: 'darwin', arch: 'arm64', distribution: { kind: 'archive', source: 'GitHub releases', url: 'https://example.test/acme.zip' },
    targetDir: '/home/u/.dsh/tools/acme.cli/1.4.0', executablePath: '/home/u/.dsh/tools/acme.cli/1.4.0/bin/acme',
    systemInstall: { executablePath: '/usr/bin/acme', version: '1.2.0', compatible: false },
    installable: true, actions: ['download the official archive', 'verify sha256'],
    actionIds: ['download-archive', 'verify-sha256'], createdAt: '2026-10-17T00:00:00.000Z',
    expiresAt: '2026-10-17T00:10:00.000Z', ...overrides }
}
function task(overrides: Partial<DependencyInstallTask> = {}): DependencyInstallTask {
  return { taskId: 'task-1', dependencyId: 'acme.cli', planId: 'plan-1', version: '1.4.0', platform: 'darwin',
    arch: 'arm64', targetDir: '/home/u/.dsh/tools/acme.cli/1.4.0', state: 'running',
    progress: { stage: 'downloading', fraction: 0.5, receivedBytes: 50, totalBytes: 100 },
    startedAt: '2026-10-17T00:00:00.000Z', ...overrides }
}
interface FakeRuntime extends ClueRuntimeApi {
  readonly calls: string[]
  dependencies: readonly DependencyStatus[]
  connections: readonly ConnectionStatusProjection[]
  planResult: DependencyInstallPlan
  taskResult: DependencyInstallTask
  pollResult?: ConnectionStatusProjection; latestTasks?: DependencyInstallTask[]; pollTask?: DependencyInstallTask
  planByDependency?: Record<string, DependencyInstallPlan>; taskByDependency?: Record<string, DependencyInstallTask>
  inspectRejects?: Error; planRejects?: Error; startRejects?: Error; setPathRejects?: Error
  connectRejects?: Error; cancelRejects?: Error; statusRejects?: Error
}
function fakeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
  const calls: string[] = []
  const runtime: FakeRuntime = {
    calls, dependencies: [dependency()], connections: [connection()], planResult: plan(), taskResult: task(),
    ...overrides,
    dependenciesInspect: async input => {
      calls.push(`inspect:${input?.dependencyId ?? '*'}:${input?.refresh === true ? 'refresh' : 'cached'}`)
      if (runtime.inspectRejects !== undefined) throw runtime.inspectRejects; return runtime.dependencies
    },
    dependenciesPlan: async dependencyId => {
      calls.push(`plan:${dependencyId}`)
      if (runtime.planRejects !== undefined) throw runtime.planRejects
      return runtime.planByDependency?.[dependencyId] ?? runtime.planResult
    },
    dependenciesStart: async (dependencyId, planId) => {
      calls.push(`start:${dependencyId}:${planId}`)
      if (runtime.startRejects !== undefined) throw runtime.startRejects
      return runtime.taskByDependency?.[dependencyId] ?? runtime.taskResult
    },
    dependenciesStatus: async dependencyId => {
      calls.push(`status:${dependencyId ?? '*'}`)
      if (runtime.statusRejects !== undefined) throw runtime.statusRejects
      if (runtime.latestTasks === undefined) return runtime.pollTask === undefined ? [] : [runtime.pollTask]
      return dependencyId === undefined ? runtime.latestTasks
        : runtime.latestTasks.filter(item => item.dependencyId === dependencyId)
    },
    dependenciesCancel: async (dependencyId, taskId) => {
      calls.push(`cancel:${dependencyId}:${taskId ?? '*'}`)
      if (runtime.cancelRejects !== undefined) throw runtime.cancelRejects
      return task({ taskId: taskId ?? 'task-1', state: 'cancelled' })
    },
    dependenciesSetPath: async (dependencyId, path) => {
      calls.push(`setPath:${dependencyId}:${path}`); if (runtime.setPathRejects !== undefined) throw runtime.setPathRejects
      return dependency({ manualPath: path, resolvedFrom: 'manual', executablePath: path })
    },
    dependenciesClearPath: async dependencyId => {
      calls.push(`clearPath:${dependencyId}`)
      return dependency()
    },
    connectionsStatus: async () => { calls.push('connectionsStatus'); return runtime.connections },
    connectionsConnect: async connectionId => {
      calls.push(`connect:${connectionId}`); if (runtime.connectRejects !== undefined) throw runtime.connectRejects
      return connection({ connectionId, authorization: 'authorizing', action: 'connect', prompt: {
        verificationUrl: 'https://example.test/device', userCode: 'ABCD-1234', expiresAt: '2026-10-17T00:10:00.000Z',
        qr: { uri: 'acme://device?code=ABCD-1234' }, instructions: 'Open the URL and enter the code.',
      } })
    },
    connectionsPoll: async connectionId => { calls.push(`poll:${connectionId}`); return runtime.pollResult ?? connection({ connectionId }) },
    connectionsCancel: async connectionId => {
      calls.push(`connectionsCancel:${connectionId}`)
      return connection({ connectionId, authorization: 'not-authorized', action: 'connect' })
    },
  }
  return runtime
}
const BASE_PROPS = {
  sourceId: 'acme.docs', sourceName: 'Acme Docs', dependencyIds: ['acme.cli'], connectionId: 'acme.auth',
}
async function flush(turns = 8): Promise<void> {
  for (let index = 0; index < turns; index += 1) await act(async () => { await Promise.resolve() })
}
async function mount(runtime: FakeRuntime, overrides: Partial<Parameters<typeof SourceConfigPage>[0]> = {}): Promise<RenderedRoot> {
  const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime, ...overrides })); await flush()
  return rendered
}
function click(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll<HTMLElement>('button, a')]
    .find(candidate => candidate.getAttribute('aria-label') === label || candidate.textContent?.trim() === label)
  if (button === undefined) throw new Error(`no control labelled "${label}" in ${container.textContent}`); act(() => { button.click() })
}
function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function primaryText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement
  for (const details of clone.querySelectorAll('details')) details.remove(); return clone.textContent ?? ''
}
function openDetails(container: HTMLElement, summary: string): HTMLDetailsElement {
  const details = [...container.querySelectorAll<HTMLDetailsElement>('details')]
    .find(candidate => candidate.querySelector('summary')?.textContent?.includes(summary) === true)
  if (details === undefined) throw new Error(`no details "${summary}" in ${container.textContent}`)
  act(() => { details.open = true; details.dispatchEvent(new Event('toggle')) }); return details
}
const rowFor = (container: HTMLElement, id = 'acme.cli'): Element | null =>
  container.querySelector(`[data-clue-dependency="${id}"]`)
const kindOf = (container: HTMLElement, id = 'acme.cli'): string | null | undefined =>
  rowFor(container, id)?.querySelector('[data-kind]')?.getAttribute('data-kind')
function pathInput(c: HTMLElement): HTMLInputElement { return c.querySelector<HTMLInputElement>('input[placeholder="Absolute path to the executable"]')! }
async function openPlan(c: HTMLElement): Promise<void> { click(c, 'One-click install'); await flush(1) }
async function startInstall(c: HTMLElement): Promise<void> {
  await openPlan(c); click(c, 'Confirm and install'); await flush(1)
}
async function recheck(c: HTMLElement): Promise<void> { click(c, 'Recheck'); await flush() }
async function tick(ms: number): Promise<void> { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }
async function withFakeTimers(run: () => Promise<void>): Promise<void> {
  vi.useFakeTimers()
  try { await run() } finally { vi.useRealTimers() }
}
describe('SourceConfigPage dependency section', () => {
  it('withholds terminal verdicts until the first read and keeps diagnostics behind one disclosure', async () => {
    const runtime = fakeRuntime()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalInspect = runtime.dependenciesInspect
    const originalStatus = runtime.connectionsStatus
    runtime.dependenciesInspect = async input => { await gate; return originalInspect(input) }
    runtime.connectionsStatus = async (...args) => { await gate; return originalStatus(...args) }
    const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime }))
    const first = rendered.container.textContent ?? ''
    expect([first.includes('Not installed'), first.includes('Not configured'),
      first.includes('Not checked'), kindOf(rendered.container)]).toEqual([false, false, true, 'unchecked'])
    release(); await flush()
    expect([kindOf(rendered.container), rendered.container.textContent?.includes('Ready'), primaryText(rendered.container).includes('Acme CLI')]).toEqual(['ready', true, true])
    expect(runtime.calls).toEqual(['inspect:acme.cli:cached', 'connectionsStatus', 'status:*'])
    expect(rendered.container.querySelector('section[data-clue-config="acme.docs"]')?.getAttribute('aria-label'))
      .toBe('Acme Docs')
    const details = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-dependency-details]')!
    expect([details.open, primaryText(rendered.container).includes('/usr/local/bin/acme'),
      primaryText(rendered.container).includes('Minimum 1.2.0 · Recommended 1.4.0')]).toEqual([false, false, false])
    openDetails(rendered.container, 'Actual path')
    expect(['/usr/local/bin/acme', '1.4.0', 'Minimum 1.2.0 · Recommended 1.4.0']
      .every(text => rendered.container.textContent?.includes(text))).toBe(true)
    runtime.calls.length = 0
    await recheck(rendered.container)
    expect(runtime.calls).toEqual(['inspect:acme.cli:refresh', 'connectionsStatus', 'status:*'])
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
    rendered.unmount()
    expect([signal !== undefined, signal?.aborted]).toEqual([true, true])
  })
  it('prioritizes recovery tasks without remounting the path draft or disclosure', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    const firstTask = (): string | null | undefined => rendered.container.querySelector('[data-clue-config] > section')
      ?.getAttribute('aria-label')
    expect(firstTask()).toBe('Connection and authorization')
    const details = openDetails(rendered.container, 'Actual path')
    const input = pathInput(rendered.container)
    type(input, '/opt/draft')
    runtime.dependencies = [dependency({ state: 'missing' })]
    await recheck(rendered.container)
    expect([firstTask(), pathInput(rendered.container) === input, input.value, details.open])
      .toEqual(['CLI dependency', true, '/opt/draft', true])
    runtime.dependencies = [dependency()]
    await recheck(rendered.container)
    expect([firstTask(), pathInput(rendered.container) === input, details.open])
      .toEqual(['Connection and authorization', true, true])
    rendered.unmount()
  })
  it('validates then applies a manual path, clears a failed probe, reports failures inline and clears the override', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ manualPath: '/opt/acme' })] })
    const rendered = await mount(runtime)
    runtime.inspectRejects = new Error('the probe timed out')
    await recheck(rendered.container)
    expect(kindOf(rendered.container)).toBe('request-failed')
    runtime.inspectRejects = undefined
    openDetails(rendered.container, 'Actual path')
    const input = pathInput(rendered.container)
    type(input, 'acme'); click(rendered.container, 'Use path')
    expect([runtime.calls.some(call => call.startsWith('setPath:')), rendered.container.textContent?.includes('Enter an absolute path')]).toEqual([false, true])
    runtime.setPathRejects = new Error('the path does not exist')
    type(input, '/nope/acme'); click(rendered.container, 'Use path'); await flush(1)
    expect([runtime.calls.includes('setPath:acme.cli:/nope/acme'),
      rendered.container.querySelector('[data-clue-path-error="acme.cli"]')?.textContent?.includes('the path does not exist'),
      rendered.container.textContent?.includes('/usr/local/bin/acme')]).toEqual([true, true, true])
    runtime.setPathRejects = undefined
    type(input, '/opt/acme'); click(rendered.container, 'Use path'); await flush()
    expect([kindOf(rendered.container), rendered.container.textContent?.includes('/opt/acme')]).toEqual(['ready', true])
    click(rendered.container, 'Clear manual path'); await flush(1)
    expect(runtime.calls).toContain('clearPath:acme.cli')
    rendered.unmount()
  })
  it('offers the one-click install only when the host can install, and keeps manual guidance otherwise', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ installable: false, supported: false,
      manualInstall: { instructions: 'Install the package from your distribution', url: 'https://example.test/manual' } })] })
    const rendered = await mount(runtime)
    const install = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'One-click install')
    expect([install?.disabled, rendered.container.textContent?.includes('Automatic install is not available on this platform.'),
      rendered.container.textContent?.includes('Install the package from your distribution'),
      rendered.container.querySelector('a[href="https://example.test/manual"]') !== null]).toEqual([true, true, true, true])
    rendered.unmount()
  })
  it('waits for the mount read before applying a path and never lets an older Recheck overwrite it', async () => {
    const runtime = fakeRuntime()
    let releaseMount!: () => void
    const mountGate = new Promise<void>(resolve => { releaseMount = resolve })
    const originalInspect = runtime.dependenciesInspect
    let gated = false
    runtime.dependenciesInspect = async input => { if (gated) await mountGate; return originalInspect(input) }
    gated = true
    const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime }))
    await act(async () => { await Promise.resolve() })
    openDetails(rendered.container, 'Actual path')
    const input = pathInput(rendered.container)
    type(input, '/opt/acme'); click(rendered.container, 'Use path'); await flush(1)
    expect(runtime.calls.some(call => call.startsWith('setPath:'))).toBe(false)
    releaseMount(); await flush()
    expect([runtime.calls.includes('setPath:acme.cli:/opt/acme'), rendered.container.textContent?.includes('/opt/acme')]).toEqual([true, true])
    let releaseRecheck!: () => void
    const recheckGate = new Promise<void>(resolve => { releaseRecheck = resolve })
    runtime.dependenciesInspect = async input => { if (gated) await recheckGate; return originalInspect(input) }
    click(rendered.container, 'Recheck'); await flush(1)
    type(pathInput(rendered.container), '/opt/new'); click(rendered.container, 'Use path'); await flush(1)
    expect([runtime.calls.includes('setPath:acme.cli:/opt/new'), rendered.container.textContent?.includes('/opt/new')]).toEqual([true, true])
    releaseRecheck(); await flush()
    expect(rowFor(rendered.container)?.textContent?.includes('/opt/new')).toBe(true)
    rendered.unmount()
  })
  it('plans the first missing dependency from a user-clicked install entry but never starts or replays it', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ state: 'missing', version: undefined, executablePath: undefined })] })
    const rendered = await mount(runtime, { initialAction: 'install' }); await flush()
    expect([runtime.calls.filter(call => call === 'plan:acme.cli').length,
      runtime.calls.some(call => call.startsWith('start:')),
      rendered.container.textContent?.includes('Install plan: Acme CLI 1.4.0'),
      rendered.container.textContent?.includes('Confirm and install')]).toEqual([1, false, true, true])
    await recheck(rendered.container); await flush()
    expect(runtime.calls.filter(call => call === 'plan:acme.cli')).toHaveLength(1)
    rendered.unmount()
    const regular = fakeRuntime({ dependencies: [dependency({ state: 'missing' })] })
    const regularView = await mount(regular); await flush()
    const ready = fakeRuntime()
    const readyView = await mount(ready, { initialAction: 'install' }); await flush()
    expect([regular.calls.some(call => call.startsWith('plan:')), ready.calls.some(call => call.startsWith('plan:'))]).toEqual([false, false])
    regularView.unmount(); readyView.unmount()
  })
  it('keeps the plan decision primary, folds its steps, and starts only after confirmation', async () => {
    const runtime = fakeRuntime(); const rendered = await mount(runtime)
    await openPlan(rendered.container)
    const text = primaryText(rendered.container)
    expect(runtime.calls).toContain('plan:acme.cli')
    expect(runtime.calls.some(call => call.startsWith('start:'))).toBe(false)
    expect(['Install plan: Acme CLI 1.4.0', 'Install to /home/u/.dsh/tools/acme.cli/1.4.0',
      'darwin / arm64', 'GitHub releases · Official archive', 'Plan expires', 'Confirm and install']
      .every(value => text.includes(value))).toBe(true)
    expect(['Download the official archive', 'Existing system install'].map(value => text.includes(value))).toEqual([false, false])
    const planDetails = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-plan-details]')!
    expect(planDetails.open).toBe(false)
    openDetails(rendered.container, 'Task detail')
    expect(['Download the official archive', 'Verify SHA-256', 'Existing system install', '/usr/bin/acme',
      '1.2.0 · incompatible', new Date('2026-10-17T00:10:00.000Z').toLocaleString(), '{time}']
      .map(value => rendered.container.textContent?.includes(value))).toEqual([true, true, true, true, true, true, false])
    click(rendered.container, 'Confirm and install'); await flush(1)
    expect([runtime.calls.includes('start:acme.cli:plan-1'), rendered.container.textContent?.includes('Downloading'),
      rendered.container.querySelector('[role="progressbar"]') !== null, kindOf(rendered.container)]).toEqual([true, true, true, 'installing'])
    rendered.unmount()
    const cancelled = fakeRuntime(); const cancelledView = await mount(cancelled)
    await openPlan(cancelledView.container)
    click(cancelledView.container, 'Cancel')
    expect([cancelled.calls.some(call => call.startsWith('start:')),
      cancelledView.container.textContent?.includes('Confirm and install')]).toEqual([false, false])
    cancelledView.unmount()
  })
  it('shows why a plan cannot install and whether a PATH copy was detected', async () => {
    const runtime = fakeRuntime({ planResult: plan({ installable: false,
      unavailableReason: 'no archive for linux-arm64', systemInstall: undefined }) })
    const rendered = await mount(runtime)
    await openPlan(rendered.container)
    expect([rendered.container.textContent?.includes('Automatic install is not available on this platform.'),
      rendered.container.textContent?.includes('no archive for linux-arm64'),
      primaryText(rendered.container).includes('None detected'), rendered.container.textContent?.includes('Confirm and install')])
      .toEqual([true, true, false, false])
    openDetails(rendered.container, 'Task detail')
    expect(rendered.container.textContent).toContain('None detected')
    click(rendered.container, 'Cancel')
    expect(runtime.calls.some(call => call.startsWith('start:'))).toBe(false)
    rendered.unmount()
  })
  it('polls a running task to completion, re-probes, shows unchecked during the probe and then stops', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime(); const rendered = await mount(runtime)
      await startInstall(rendered.container)
      runtime.calls.length = 0
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const originalInspect = runtime.dependenciesInspect
      runtime.dependenciesInspect = async input => { await gate; return originalInspect(input) }
      runtime.pollTask = task({ state: 'succeeded', progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' })
      await tick(1000)
      expect([runtime.calls.includes('status:*'), kindOf(rendered.container), rendered.container.textContent?.includes('Not checked')])
        .toEqual([true, 'unchecked', true])
      release(); await flush()
      expect([kindOf(rendered.container), runtime.calls.includes('inspect:acme.cli:refresh'), rendered.container.textContent?.includes('Done')])
        .toEqual(['ready', true, true])
      const settled = runtime.calls.length
      await tick(3000)
      expect(runtime.calls).toHaveLength(settled)
      rendered.unmount()
    })
  })
  it('cancels a running install from another view and gates duplicate cancellation', async () => {
    const runtime = fakeRuntime(); const first = await mount(runtime)
    await startInstall(first.container)
    runtime.latestTasks = [task()]
    const second = await mount(runtime)
    expect([second.container.querySelector('[role="progressbar"]') !== null, second.container.textContent?.includes('Cancel install')])
      .toEqual([true, true])
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalCancel = runtime.dependenciesCancel
    runtime.dependenciesCancel = async (...args) => { const result = await originalCancel(...args); await gate; return result }
    const cancel = [...second.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Cancel install')!
    act(() => { cancel.click(); cancel.click() })
    await act(async () => { await Promise.resolve() })
    expect([runtime.calls.filter(call => call.startsWith('cancel:')).length, cancel.disabled]).toEqual([1, true])
    release(); await flush()
    expect([second.container.textContent?.includes('Install cancelled'), first.container.textContent?.includes('Install cancelled')])
      .toEqual([true, true])
    first.unmount(); second.unmount()
  })
  it('confirming twice sends one start and disables install while the task runs', async () => {
    const runtime = fakeRuntime(); const rendered = await mount(runtime)
    await openPlan(rendered.container)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStart = runtime.dependenciesStart
    runtime.dependenciesStart = async (...args) => { const result = await originalStart(...args); await gate; return result }
    const confirm = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Confirm and install')!
    act(() => { confirm.click(); confirm.click() })
    await act(async () => { await Promise.resolve() })
    expect([runtime.calls.filter(call => call.startsWith('start:')).length, confirm.disabled]).toEqual([1, true])
    release(); await flush()
    const install = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'One-click install')!
    expect([install.disabled, rendered.container.textContent?.includes('Cancel install')]).toEqual([true, true])
    rendered.unmount()
  })
})
describe('SourceConfigPage connection and authorization', () => {
  it('shows authorization/prompt/QR and polls or cancels only on explicit clicks', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect' })] })
    const rendered = await mount(runtime)
    expect([rendered.container.textContent?.includes('Not authorized'),
      runtime.calls.some(call => call.startsWith('connect:'))]).toEqual([true, false])
    click(rendered.container, 'Authorize'); await flush(1)
    const text = rendered.container.textContent ?? ''
    const qr = rendered.container.querySelector('[data-clue-qr] svg[role="img"]')
    expect([runtime.calls.includes('connect:acme.auth'), text.includes('https://example.test/device'), text.includes('ABCD-1234'),
      text.includes('acme://device?code=ABCD-1234'), text.includes('Open the URL and enter the code.'),
      qr !== null, qr?.getAttribute('aria-label') === 'Authorization QR code',
      (qr?.querySelector('path')?.getAttribute('d')?.length ?? 0) > 0,
      text.includes(new Date('2026-10-17T00:10:00.000Z').toLocaleString()), text.includes('{time}')])
      .toEqual([true, true, true, true, true, true, true, true, true, false])
    runtime.calls.length = 0
    runtime.pollResult = connection({ authorization: 'authorizing', action: 'connect' })
    click(rendered.container, 'I’m done — check status'); await flush(1)
    expect(runtime.calls).toContain('poll:acme.auth')
    runtime.calls.length = 0
    click(rendered.container, 'Cancel authorization'); await flush(1)
    expect(runtime.calls).toEqual(['connectionsCancel:acme.auth'])
    rendered.unmount()
  })
  it('never renders tokens, raw stdout or secret fields even when a DTO smuggles them in', async () => {
    const smuggledDependency = { ...dependency(), token: 'ghp_SECRET_TOKEN', stdout: 'RAW STDOUT SECRET',
      env: { SECRET: 'ENV SECRET' } } as unknown as DependencyStatus
    const smuggledConnection = { ...connection({ authorization: 'not-authorized', action: 'connect' }),
      token: 'lark_SECRET_TOKEN', stdout: 'CONNECTION STDOUT SECRET' } as unknown as ConnectionStatusProjection
    const runtime = fakeRuntime({ dependencies: [smuggledDependency], connections: [smuggledConnection] })
    const rendered = await mount(runtime)
    const text = rendered.container.textContent ?? ''
    expect(['ghp_SECRET_TOKEN', 'RAW STDOUT SECRET', 'ENV SECRET', 'lark_SECRET_TOKEN', 'CONNECTION STDOUT SECRET']
      .some(secret => text.includes(secret))).toBe(false)
    expect(rendered.container.querySelector('[data-clue-secret]')).toBeNull()
    rendered.unmount()
  })
  it('marks both connection rows request-failed with last-known context and recovers on Retry', async () => {
    const runtime = fakeRuntime()
    const rendered = await mount(runtime)
    const details = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-connection-details]')!
    expect([details.open, details.querySelector('summary')?.textContent?.includes('Read-only'),
      primaryText(rendered.container).includes('Application configuration')]).toEqual([false, true, false])
    runtime.connectionsStatus = async () => { throw new Error('the connection status route failed') }
    await recheck(rendered.container)
    const section = rendered.container.querySelector<HTMLElement>('[aria-label="Connection and authorization"]')!
    expect([section.querySelector('[data-kind="request-failed"]') !== null, section.querySelector('[data-authorization]') === null,
      section.querySelector('[data-configuration]') === null, section.querySelectorAll('[data-stale="true"]').length,
      section.textContent?.includes('Last known: Ready'), details.open]).toEqual([true, true, true, 2, true, true])
    expect(section.textContent).toContain('Request failed')
    expect(rendered.container.textContent).not.toContain('Not configured')
    runtime.connectionsStatus = async () => [connection({ authorization: 'not-authorized', action: 'connect' })]
    await recheck(rendered.container)
    expect([rendered.container.textContent?.includes('Not authorized'), rendered.container.textContent?.includes('Request failed')])
      .toEqual([true, false])
    rendered.unmount()
  })
  it('hands a connect failure back to the same page with the settings preserved', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect' })],
      connectRejects: new Error('the authorization request failed') })
    const rendered = await mount(runtime)
    click(rendered.container, 'Authorize'); await flush(1)
    expect([rendered.container.textContent?.includes('the authorization request failed'),
      rendered.container.querySelector('[data-clue-connection-action-error]')?.textContent?.includes('the authorization request failed'),
      rendered.container.textContent?.includes('Not authorized'), rendered.container.textContent?.includes('/usr/local/bin/acme')])
      .toEqual([true, true, true, true])
    rendered.unmount()
  })
})
describe('SourceConfigPage failure handling', () => {
  it('keeps the last path/version when a recheck fails, recovers on retry, and shows failed DTO errors inline', async () => {
    const runtime = fakeRuntime({ dependencies: [dependency({ manualPath: '/opt/acme' })] })
    const rendered = await mount(runtime)
    runtime.inspectRejects = new Error('the probe timed out')
    await recheck(rendered.container)
    expect([rendered.container.textContent?.includes('the probe timed out'),
      rendered.container.textContent?.includes('/usr/local/bin/acme'), kindOf(rendered.container)]).toEqual([true, true, 'request-failed'])
    runtime.inspectRejects = undefined
    await recheck(rendered.container)
    expect(kindOf(rendered.container)).toBe('ready')
    runtime.dependencies = [dependency({ state: 'failed', error: { category: 'failed', message: 'the executable exited with 3' } })]
    await recheck(rendered.container)
    expect(rendered.container.textContent).toContain('the executable exited with 3')
    rendered.unmount()
  })
  it('reports plan/start failures inline and keeps the page usable', async () => {
    const planRuntime = fakeRuntime({ planRejects: new Error('no verified release for this platform') })
    const planned = await mount(planRuntime)
    await openPlan(planned.container)
    expect([planned.container.textContent?.includes('no verified release for this platform'),
      planned.container.querySelector('[data-clue-dependency-action-error="acme.cli"]')?.textContent?.includes('no verified release for this platform'),
      planned.container.textContent?.includes('Confirm and install')]).toEqual([true, true, false])
    planned.unmount()
    const startRuntime = fakeRuntime({ startRejects: new Error('the installer refused to start') })
    const started = await mount(startRuntime)
    await startInstall(started.container)
    expect([started.container.textContent?.includes('the installer refused to start'),
      started.container.querySelector('[role="progressbar"]') === null,
      started.container.textContent?.includes('Confirm and install')]).toEqual([true, true, true])
    started.unmount()
  })
})
describe('SourceConfigPage install task polling', () => {
  it('stops polling when the runtime no longer reports the remembered task', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime(); const rendered = await mount(runtime)
      await startInstall(rendered.container)
      runtime.calls.length = 0
      await tick(1000)
      expect([runtime.calls.filter(call => call === 'status:*').length,
        rendered.container.querySelector('[role="progressbar"]') === null]).toEqual([1, true])
      await tick(3000)
      expect(runtime.calls.filter(call => call === 'status:*')).toHaveLength(1)
      rendered.unmount()
    })
  })
  it('gives up after repeated status failures and clears a transient poll error on success', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime(); const rendered = await mount(runtime)
      await startInstall(rendered.container)
      runtime.calls.length = 0
      runtime.statusRejects = new Error('the status route is temporarily down')
      await tick(1000)
      expect([rendered.container.textContent?.includes('the status route is temporarily down'),
        rendered.container.querySelector('[data-clue-poll-error="acme.cli"]')?.textContent?.includes('the status route is temporarily down')])
        .toEqual([true, true])
      runtime.statusRejects = undefined
      runtime.pollTask = task({ state: 'succeeded', progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' })
      await tick(1000)
      expect([rendered.container.textContent?.includes('the status route is temporarily down'),
        rendered.container.querySelector('[data-clue-poll-error]') === null, kindOf(rendered.container)]).toEqual([false, true, 'ready'])
      rendered.unmount()
      const failing = fakeRuntime({ statusRejects: new Error('the status route is down') })
      const failingView = await mount(failing)
      await startInstall(failingView.container)
      failing.calls.length = 0
      for (let index = 0; index < 3; index += 1) await tick(1000)
      expect([failingView.container.textContent?.includes('the status route is down'),
        failing.calls.filter(call => call === 'status:*').length,
        failingView.container.querySelector('[role="progressbar"]') === null]).toEqual([true, 3, true])
      await tick(3000)
      expect(failing.calls.filter(call => call === 'status:*')).toHaveLength(3)
      failingView.unmount()
    })
  })
  it('keeps one shared poller for every running dependency and every window, then re-reads every settled dependency', async () => {
    await withFakeTimers(async () => {
      const other = dependency({ dependencyId: 'other.cli', name: 'Other CLI', command: 'other' })
      const runtime = fakeRuntime({ dependencies: [dependency(), other],
        planByDependency: { 'other.cli': plan({ planId: 'plan-2', dependencyId: 'other.cli', name: 'Other CLI' }) },
        taskByDependency: { 'other.cli': task({ taskId: 'task-2', dependencyId: 'other.cli', planId: 'plan-2' }) } })
      const first = await mount(runtime, { dependencyIds: ['acme.cli', 'other.cli'] })
      const clickIn = (id: string, label: string): void => {
        const row = rowFor(first.container, id)!
        const control = [...row.querySelectorAll<HTMLElement>('button')].find(candidate => candidate.textContent?.trim() === label)!
        act(() => { control.click() })
      }
      for (const id of ['acme.cli', 'other.cli']) {
        clickIn(id, 'One-click install'); await flush(1)
        clickIn(id, 'Confirm and install'); await flush(1)
      }
      expect(first.container.querySelectorAll('[role="progressbar"]')).toHaveLength(2)
      runtime.latestTasks = [task(), task({ taskId: 'task-2', dependencyId: 'other.cli', planId: 'plan-2' })]
      const second = await mount(runtime, { dependencyIds: ['acme.cli', 'other.cli'] })
      expect(second.container.querySelectorAll('[role="progressbar"]')).toHaveLength(2)
      const fresh = new Map([
        ['acme.cli', dependency({ version: '2.0.0', executablePath: '/opt/acme/2.0.0/bin/acme' })],
        ['other.cli', dependency({ dependencyId: 'other.cli', name: 'Other CLI', command: 'other',
          version: '3.0.0', executablePath: '/opt/other/3.0.0/bin/other' })],
      ])
      const reRead: string[] = []
      runtime.dependenciesInspect = async input => {
        const id = input?.dependencyId ?? ''
        reRead.push(id)
        const item = fresh.get(id)
        return item === undefined ? [] : [item]
      }
      runtime.latestTasks = [...fresh.keys()].map(id => task({ taskId: `task-${id}`, dependencyId: id,
        planId: `plan-${id}`, state: 'succeeded', progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' }))
      runtime.calls.length = 0
      await tick(1000); await flush()
      expect([runtime.calls.filter(call => call === 'status:*').length, new Set(reRead)])
        .toEqual([1, new Set(['acme.cli', 'other.cli'])])
      for (const [id, item] of fresh) {
        expect([kindOf(first.container, id), rowFor(first.container, id)?.textContent?.includes(item.version!),
          rowFor(first.container, id)?.textContent?.includes(item.executablePath!)]).toEqual(['ready', true, true])
      }
      expect([first.container.textContent?.includes('Done'), second.container.textContent?.includes('Done')]).toEqual([true, true])
      first.unmount(); second.unmount()
    })
  })
  it('a recovered poll clears only the poll error, never a cancel failure', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime(); const rendered = await mount(runtime)
      await startInstall(rendered.container)
      runtime.pollTask = task()
      runtime.cancelRejects = new Error('the cancel route is down')
      click(rendered.container, 'Cancel install'); await flush(1)
      const row = rowFor(rendered.container)!
      expect(row.querySelector('[data-clue-dependency-action-error="acme.cli"]')?.textContent)
        .toContain('the cancel route is down')
      await tick(1000)
      expect([row.querySelector('[data-clue-poll-error]') === null,
        row.querySelector('[data-clue-dependency-action-error="acme.cli"]')?.textContent?.includes('the cancel route is down')])
        .toEqual([true, true])
      rendered.unmount()
    })
  })
})
describe('SourceConfigPage cross-window observation fencing', () => {
  it('lets a same-dependency status observation supersede a read but not an unrelated dependency observation', async () => {
    const runtime = fakeRuntime(); const rendered = await mount(runtime)
    const seen: DependencyStatus[][] = []
    const unsubscribe = subscribeClueRuntime(runtime, observation => {
      if (observation.kind === 'statuses') seen.push([...observation.dependencies])
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalInspect = runtime.dependenciesInspect
    let gated = false
    runtime.dependenciesInspect = async input => { if (gated) await gate; return originalInspect(input) }
    gated = true
    seen.length = 0
    click(rendered.container, 'Recheck'); await act(async () => { await Promise.resolve() })
    act(() => { publishClueStatuses(runtime, [dependency({ manualPath: '/opt/acme', executablePath: '/opt/acme', resolvedFrom: 'manual' })]) })
    release(); await flush()
    expect([rowFor(rendered.container)?.textContent?.includes('/opt/acme'),
      seen.some(batch => batch.some(item => item.executablePath === '/usr/local/bin/acme'))]).toEqual([true, false])
    runtime.dependencies = [dependency({ version: '5.0.0', executablePath: '/opt/acme-5' })]
    let releaseUnrelated!: () => void
    const unrelatedGate = new Promise<void>(resolve => { releaseUnrelated = resolve })
    runtime.dependenciesInspect = async input => { if (gated) await unrelatedGate; return originalInspect(input) }
    click(rendered.container, 'Recheck'); await act(async () => { await Promise.resolve() })
    act(() => { publishClueStatuses(runtime, [dependency({ dependencyId: 'other.cli', name: 'Other CLI', command: 'other', state: 'missing' })]) })
    releaseUnrelated(); await flush()
    expect([rowFor(rendered.container)?.textContent?.includes('/opt/acme-5'), kindOf(rendered.container)]).toEqual([true, 'ready'])
    unsubscribe(); rendered.unmount()
  })
  it('a newer authorization observation is not rolled back by an older connection read', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect' })] })
    const rendered = await mount(runtime)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStatus = runtime.connectionsStatus
    let gated = false
    runtime.connectionsStatus = async (...args) => { if (gated) await gate; return originalStatus(...args) }
    gated = true
    click(rendered.container, 'Recheck'); await act(async () => { await Promise.resolve() })
    act(() => { publishClueStatuses(runtime, [], [connection({ authorization: 'authorizing', action: 'none',
      prompt: { verificationUrl: 'https://example.test/fresh-auth', expiresAt: '2026-10-17T00:20:00.000Z' } })]) })
    release(); await flush()
    expect(rendered.container.textContent).toContain('https://example.test/fresh-auth')
    rendered.unmount()
  })
  it('a same-dependency task observation during the mount read does not discard the connection projection', async () => {
    const runtime = fakeRuntime()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStatus = runtime.connectionsStatus
    let gated = false
    runtime.connectionsStatus = async (...args) => { if (gated) await gate; return originalStatus(...args) }
    gated = true
    const rendered = renderRoot(createElement(SourceConfigPage, { ...BASE_PROPS, runtime }))
    await flush(6)
    act(() => { publishClueTask(runtime, task()) })
    release(); await flush()
    expect([kindOf(rendered.container), rendered.container.querySelector('[data-authorization]')?.getAttribute('data-authorization')])
      .toEqual(['installing', 'ready'])
    rendered.unmount()
  })
  it('re-reads a dependency whose probe a same-dependency observation superseded', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime(); const rendered = await mount(runtime)
      await startInstall(rendered.container)
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      const originalInspect = runtime.dependenciesInspect
      let calls = 0
      runtime.dependencies = [dependency({ version: '2.0.0', executablePath: '/opt/acme-2' })]
      runtime.dependenciesInspect = async input => { calls += 1; if (calls === 1) await gate; return originalInspect(input) }
      runtime.pollTask = task({ state: 'succeeded', progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' })
      await tick(1000)
      act(() => { publishClueStatuses(runtime, [dependency({ version: '1.4.0', executablePath: '/usr/local/bin/acme' })]) })
      release(); await flush()
      expect([calls, rowFor(rendered.container)?.textContent?.includes('/opt/acme-2'),
        rowFor(rendered.container)?.textContent?.includes('/usr/local/bin/acme')]).toEqual([2, true, false])
      rendered.unmount()
    })
  })
  it('shows a failed post-install re-probe on the row instead of swallowing it', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime(); const rendered = await mount(runtime)
      await startInstall(rendered.container)
      runtime.dependenciesInspect = async () => { throw new Error('the dependency probe is down') }
      runtime.pollTask = task({ state: 'succeeded', progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' })
      await tick(1000); await flush()
      const row = rowFor(rendered.container)!
      expect([kindOf(rendered.container), row.querySelector('[data-clue-poll-error="acme.cli"]')?.textContent?.includes('the dependency probe is down'),
        row.textContent?.includes('/usr/local/bin/acme')]).toEqual(['request-failed', true, true])
      rendered.unmount()
    })
  })
  it('an older task-adoption read cannot resurrect a task another view already settled', async () => {
    const runtime = fakeRuntime(); const rendered = await mount(runtime)
    runtime.latestTasks = [task()]
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const originalStatus = runtime.dependenciesStatus
    let gated = false
    runtime.dependenciesStatus = async (...args) => { if (gated) await gate; return originalStatus(...args) }
    gated = true
    click(rendered.container, 'Recheck'); await flush()
    act(() => { publishClueTask(runtime, task({ state: 'succeeded', progress: { stage: 'completed' }, finishedAt: '2026-10-17T00:01:00.000Z' })) })
    release(); await flush()
    expect([rendered.container.querySelector('[role="progressbar"]') === null, rendered.container.textContent?.includes('Done')])
      .toEqual([true, true])
    rendered.unmount()
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
  it('defaults docs to read/search, posts a selected edit grant and freezes choices during authorization', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect', capabilities: [], selectableCapabilities: choices })] })
    let complete!: (value: ConnectionStatusProjection) => void
    const connect = vi.fn<ClueRuntimeApi['connectionsConnect']>(() => new Promise(resolve => { complete = resolve }))
    runtime.connectionsConnect = connect
    const rendered = await mount(runtime, { sourceId: 'builtin.feishu.docs' }); await flush()
    const disclosure = rendered.container.querySelector<HTMLDetailsElement>('[data-clue-permissions]')!
    expect([disclosure.open, disclosure.querySelector('summary')?.textContent?.includes(t('clueAuthPermissionDocsRead')),
      disclosure.querySelector('summary')?.textContent?.includes(t('clueAuthPermissionDocsEdit'))]).toEqual([false, true, false])
    openDetails(rendered.container, t('clueAuthPermissions'))
    expect(['clueAuthPermissionDocsRead', 'clueAuthPermissionDocsSearch', 'clueAuthPermissionDocsEdit',
      'clueAuthPermissionTasksRead', 'clueAuthPermissionWikiRead']
      .map(key => permission(rendered.container, key as Parameters<typeof t>[0]).checked)).toEqual([true, true, false, false, false])
    act(() => permission(rendered.container, 'clueAuthPermissionDocsEdit').click())
    expect(disclosure.querySelector('summary')?.textContent).toContain(t('clueAuthPermissionDocsEdit'))
    click(rendered.container, 'Authorize')
    expect([connect.mock.calls[0]?.[2], rendered.container.querySelector('fieldset')?.disabled])
      .toEqual([['docs.read', 'docs.search', 'docs.edit'], true])
    await act(async () => { complete(connection({ authorization: 'authorizing', selectableCapabilities: choices })); await Promise.resolve() })
    expect(rendered.container.querySelector('fieldset')?.disabled).toBe(true)
    expect(connect).toHaveBeenCalledTimes(1)
    rendered.unmount()
  })
  it('restores the exact requested permissions after closing and reopening configuration', async () => {
    let saved: readonly string[] | undefined
    const permissionPreferences = { load: async () => saved,
      save: async (_connectionId: string, capabilities: readonly string[]) => { saved = [...capabilities] } }
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'ready', capabilities: ['docs.read'], selectableCapabilities: choices })] })
    const first = await mount(runtime, { sourceId: 'builtin.feishu.docs', permissionPreferences }); await flush()
    openDetails(first.container, t('clueAuthPermissions'))
    act(() => permission(first.container, 'clueAuthPermissionDocsEdit').click()); await flush()
    expect(saved).toEqual(['docs.read', 'docs.search', 'docs.comments.read', 'docs.edit'])
    first.unmount()
    const reopened = await mount(runtime, { sourceId: 'builtin.feishu.docs', permissionPreferences }); await flush()
    openDetails(reopened.container, t('clueAuthPermissions'))
    expect([permission(reopened.container, 'clueAuthPermissionDocsEdit').checked,
      permission(reopened.container, 'clueAuthPermissionDocsSearch').checked,
      reopened.container.querySelector('[data-clue-granted-permissions]') !== null]).toEqual([true, true, true])
    reopened.unmount()
  })
  it('defaults tasks to task read only and cannot submit an empty selection', async () => {
    const runtime = fakeRuntime({ connections: [connection({ authorization: 'not-authorized', action: 'connect', capabilities: [], selectableCapabilities: choices })] })
    const connect = vi.fn<ClueRuntimeApi['connectionsConnect']>(async () => connection({ authorization: 'authorizing', selectableCapabilities: choices }))
    runtime.connectionsConnect = connect
    const rendered = await mount(runtime, { sourceId: 'builtin.feishu.tasks' }); await flush()
    expect(['clueAuthPermissionTasksRead', 'clueAuthPermissionDocsRead', 'clueAuthPermissionTasksEdit']
      .map(key => permission(rendered.container, key as Parameters<typeof t>[0]).checked)).toEqual([true, false, false])
    act(() => permission(rendered.container, 'clueAuthPermissionTasksRead').click())
    const authorize = [...rendered.container.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent === 'Authorize')!
    expect(authorize.disabled).toBe(true)
    act(() => authorize.click())
    expect(connect).not.toHaveBeenCalled()
    act(() => permission(rendered.container, 'clueAuthPermissionTasksRead').click())
    click(rendered.container, 'Authorize'); await flush()
    expect(connect.mock.calls[0]?.[2]).toEqual(['tasks.read'])
    rendered.unmount()
  })
})
describe('device-code auto-check', () => {
  const authorizing = (pollAfterMs?: number) => connection({ authorization: 'authorizing', action: 'connect', capabilities: [],
    prompt: { verificationUrl: 'https://example.test/device', userCode: 'ABCD-1234',
      expiresAt: '2026-10-17T00:10:00.000Z', ...(pollAfterMs === undefined ? {} : { pollAfterMs }) } })
  it('re-sends the explicit poll at the CLI cadence and stops at the terminal answer', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime({ connections: [authorizing(1500)] })
      runtime.connectionsPoll = async connectionId => {
        runtime.calls.push(`poll:${connectionId}`)
        return connection({ connectionId, authorization: 'ready', action: 'none' })
      }
      const rendered = await mount(runtime)
      runtime.calls.length = 0
      await tick(1499)
      expect(runtime.calls).toEqual([])
      await tick(1)
      expect(runtime.calls).toEqual(['poll:acme.auth'])
      await flush()
      expect(rendered.container.textContent).toContain('Ready')
      await tick(30_000)
      expect(runtime.calls).toEqual(['poll:acme.auth'])
      rendered.unmount()
    })
  })
  it('pauses while the page is hidden and re-arms when it is visible again', async () => {
    await withFakeTimers(async () => {
      let hidden = false
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
      try {
        const runtime = fakeRuntime({ connections: [authorizing(2000)], pollResult: authorizing(2000) })
        const rendered = await mount(runtime)
        runtime.calls.length = 0
        hidden = true; act(() => { document.dispatchEvent(new Event('visibilitychange')) })
        await tick(20_000)
        expect(runtime.calls).toEqual([])
        hidden = false; act(() => { document.dispatchEvent(new Event('visibilitychange')) })
        await tick(2000)
        expect(runtime.calls).toEqual(['poll:acme.auth'])
        rendered.unmount()
      } finally {
        delete (document as unknown as { visibilityState?: unknown }).visibilityState
      }
    })
  })
  it('falls back to the manual button after three consecutive failures', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime({ connections: [authorizing()] })
      runtime.connectionsPoll = async () => { runtime.calls.push('poll'); throw new Error('device check failed') }
      const rendered = await mount(runtime)
      runtime.calls.length = 0
      for (let round = 0; round < 3; round += 1) await tick(5_000)
      expect(runtime.calls).toEqual(['poll', 'poll', 'poll'])
      await tick(30_000)
      expect(runtime.calls).toEqual(['poll', 'poll', 'poll'])
      click(rendered.container, 'I’m done — check status'); await flush(1)
      expect(runtime.calls).toHaveLength(4)
      rendered.unmount()
    })
  })
})
describe('shared install poller steady state', () => {
  const settle = async (turns = 6): Promise<void> => {
    for (let index = 0; index < turns; index += 1) await Promise.resolve()
  }
  it('a subscriber arriving during an in-flight tick cannot start a concurrent status request', async () => {
    await withFakeTimers(async () => {
      const runtime = fakeRuntime()
      let calls = 0
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      runtime.dependenciesStatus = async () => { calls += 1; if (calls === 1) await gate; return [] }
      const first = subscribeInstallPolling(runtime, () => {})
      await tick(1000)
      const second = subscribeInstallPolling(runtime, () => {})
      await tick(1000)
      expect(calls).toBe(1)
      release(); await settle(); await tick(1000)
      expect(calls).toBe(2)
      first(); second()
    })
  })
  it('stops while the document is hidden and runs one catch-up tick when visible again', async () => {
    await withFakeTimers(async () => {
      let hidden = false
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') })
      try {
        const runtime = fakeRuntime()
        let calls = 0
        runtime.dependenciesStatus = async () => { calls += 1; return [] }
        const off = subscribeInstallPolling(runtime, () => {})
        hidden = true; document.dispatchEvent(new Event('visibilitychange'))
        await tick(5000)
        expect(calls).toBe(0)
        hidden = false; document.dispatchEvent(new Event('visibilitychange'))
        await settle()
        expect(calls).toBe(1)
        off()
      } finally {
        delete (document as unknown as { visibilityState?: unknown }).visibilityState
      }
    })
  })
})
