/**
 * S8 source status derivation (pure): one honest state per registered clue
 * source, never claiming "ready" before the runtime actually observed it.
 *
 * The approved spec distinguishes missing / incompatible / not-configured /
 * auth-expired / ready / request-failed. S8 adds two explicitly transient
 * states the spec's copy implies — `unchecked` (no observation yet) and
 * `installing` (a task is in flight) — so a settings row cannot mislabel an
 * unprobed source as ready.
 *
 * A source declares its runtime needs through S1's descriptor (`dependencyIds`
 * + `connectionId`); the statuses come from S2's `clues.dependencies.*` /
 * `clues.connections.*` DTOs. This module only DERIVES; it never probes.
 */
import { describe, expect, it } from 'vitest'
import {
  deriveClueSourceStatus,
  type ClueSourceStatusInput,
} from '../src/client/clues/settings/status.ts'
import type { ConnectionStatusProjection, DependencyStatus } from '../src/clues/runtime/types.ts'

/** One dependency status fixture (everything optional except identity/state). */
function dependency(overrides: Partial<DependencyStatus> & { dependencyId: string; state: DependencyStatus['state'] }): DependencyStatus {
  return {
    name: overrides.dependencyId,
    command: 'cli',
    platform: 'darwin',
    arch: 'arm64',
    supported: true,
    installable: true,
    minimumVersion: '1.0.0',
    recommendedVersion: '1.0.0',
    ...overrides,
  }
}

/** One connection projection fixture. */
function connection(overrides: Partial<ConnectionStatusProjection> & Pick<ConnectionStatusProjection, 'connectionId'>): ConnectionStatusProjection {
  return {
    name: overrides.connectionId,
    pluginId: 'test',
    configuration: 'ready',
    authorization: 'ready',
    credentialOwner: 'tool',
    capabilities: [],
    action: 'none',
    ...overrides,
  }
}

/** Derive with the same list-shaped inputs the settings component passes. */
function derive(overrides: Partial<ClueSourceStatusInput> = {}) {
  return deriveClueSourceStatus({
    dependencyIds: [],
    dependencies: [],
    connections: [],
    checked: true,
    ...overrides,
  })
}

describe('deriveClueSourceStatus: dependencies', () => {
  it('is ready for a source with no declared dependency once checked', () => {
    expect(derive()).toEqual({ kind: 'ready' })
  })

  it('is unchecked until an explicit observation completed', () => {
    expect(derive({ checked: false }).kind).toBe('unchecked')
    // An omitted flag means "no observation", not "observed": this pure API
    // must not hand S9/a future caller a ready verdict it never observed.
    expect(deriveClueSourceStatus({ dependencyIds: [], dependencies: [], connections: [] }).kind).toBe('unchecked')
  })

  it('reports a missing executable as missing (never ready)', () => {
    const status = derive({
      dependencyIds: ['github.gh'],
      dependencies: [dependency({ dependencyId: 'github.gh', state: 'missing' })],
    })
    expect(status.kind).toBe('missing')
    expect(status.dependency?.dependencyId).toBe('github.gh')
  })

  it('reports a below-minimum version as incompatible', () => {
    expect(derive({
      dependencyIds: ['github.gh'],
      dependencies: [dependency({ dependencyId: 'github.gh', state: 'incompatible', version: '1.9.0' })],
    }).kind).toBe('incompatible')
  })

  it('keeps a live install visible as installing instead of ready or failed', () => {
    const status = derive({
      dependencyIds: ['github.gh'],
      dependencies: [dependency({
        dependencyId: 'github.gh',
        state: 'installing',
        installation: { taskId: 't1', state: 'running', version: '2.0.0', startedAt: '2026-10-17T00:00:00.000Z' },
      })],
    })
    expect(status.kind).toBe('installing')
    expect(status.dependency?.installation?.taskId).toBe('t1')
  })

  it('maps a failed probe/install to request-failed with the sanitized message', () => {
    const status = derive({
      dependencyIds: ['github.gh'],
      dependencies: [dependency({
        dependencyId: 'github.gh',
        state: 'failed',
        error: { category: 'failed', message: 'the executable exited with 1' },
      })],
    })
    expect(status.kind).toBe('request-failed')
    expect(status.detail).toBe('the executable exited with 1')
  })

  it('treats a declared dependency the runtime never registered as missing', () => {
    expect(derive({ dependencyIds: ['ghost.cli'], dependencies: [] }).kind).toBe('missing')
  })

  it('is unchecked while a declared dependency has no observation yet', () => {
    expect(derive({
      dependencyIds: ['github.gh'],
      dependencies: [dependency({ dependencyId: 'github.gh', state: 'unknown' })],
    }).kind).toBe('unchecked')
  })

  it('requires EVERY declared dependency to be ready (shared tools and all their needs)', () => {
    expect(derive({
      dependencyIds: ['github.gh', 'github.git'],
      dependencies: [
        dependency({ dependencyId: 'github.gh', state: 'ready' }),
        dependency({ dependencyId: 'github.git', state: 'missing' }),
      ],
    }).kind).toBe('missing')
  })

  it('reports request-failed when the status request itself failed, keeping the sanitized reason', () => {
    expect(derive({ requestFailed: true, dependencyIds: [] }).kind).toBe('request-failed')
    expect(derive({
      requestFailed: true,
      dependencyIds: [],
      requestFailedDetail: 'the inspection request timed out',
    })).toEqual({ kind: 'request-failed', detail: 'the inspection request timed out' })
  })
})

describe('deriveClueSourceStatus: connections', () => {
  it('reports missing application configuration as not-configured', () => {
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({ connectionId: 'feishu.auth', configuration: 'missing', authorization: 'unknown' })],
    }).kind).toBe('not-configured')
  })

  it('reports an expired authorization as auth-expired', () => {
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({ connectionId: 'feishu.auth', authorization: 'expired' })],
    }).kind).toBe('auth-expired')
  })

  it('keeps "connect this source" distinct from "configure the application"', () => {
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({ connectionId: 'feishu.auth', authorization: 'not-authorized', action: 'connect' })],
    }).kind).toBe('not-authorized')
    // A missing application configuration stays not-configured.
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({ connectionId: 'feishu.auth', configuration: 'missing', authorization: 'not-authorized' })],
    }).kind).toBe('not-configured')
  })

  it('keeps an in-flight authorization distinct from not-configured', () => {
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({ connectionId: 'feishu.auth', authorization: 'authorizing', action: 'connect' })],
    }).kind).toBe('authorizing')
  })

  it('reports denied / insufficient scope as request-failed (an explicit failed attempt)', () => {
    for (const authorization of ['denied', 'scope-insufficient'] as const) {
      expect(derive({
        connectionId: 'feishu.auth',
        connections: [connection({ connectionId: 'feishu.auth', authorization })],
      }).kind, authorization).toBe('request-failed')
    }
  })

  it('maps an observation error to request-failed with its sanitized message', () => {
    const status = derive({
      connectionId: 'feishu.auth',
      connections: [connection({
        connectionId: 'feishu.auth',
        error: { category: 'timeout', message: 'the observation timed out' },
      })],
    })
    expect(status.kind).toBe('request-failed')
    expect(status.detail).toBe('the observation timed out')
  })

  it('is unchecked while the authorization state was never observed', () => {
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({ connectionId: 'feishu.auth', configuration: 'ready', authorization: 'unknown' })],
    }).kind).toBe('unchecked')
  })

  it('is ready only when configuration and authorization are both usable (or not required)', () => {
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({ connectionId: 'feishu.auth', authorization: 'ready' })],
    }).kind).toBe('ready')
    expect(derive({
      connectionId: 'feishu.auth',
      connections: [connection({
        connectionId: 'feishu.auth',
        configuration: 'not-required',
        authorization: 'ready',
        credentialOwner: 'none',
      })],
    }).kind).toBe('ready')
  })

  it('treats a declared connection the runtime never registered as not-configured', () => {
    expect(derive({ connectionId: 'feishu.auth', connections: [] }).kind).toBe('not-configured')
  })

  it('dependency failure wins over a ready connection', () => {
    const status = derive({
      dependencyIds: ['feishu.lark'],
      connectionId: 'feishu.auth',
      dependencies: [dependency({ dependencyId: 'feishu.lark', state: 'missing' })],
      connections: [connection({ connectionId: 'feishu.auth' })],
    })
    expect(status.kind).toBe('missing')
  })
})
