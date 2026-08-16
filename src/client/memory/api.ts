/**
 * Memory console API client — talks to the hpptools-memory plugin's
 * loopback routes (`/hpptools-memory/api/*`, same origin). The memory
 * backend (config / stats / files / models / runs / migration) lives in
 * that plugin; this panel is a pure consumer.
 */

/** One overview response (shape mirrors webui.js overviewData). */
export interface MemoryOverview {
  root: string
  migrated: { from: string; copiedItems: number; at: string } | null
  /** Legacy Pi memory path when detected and not yet migrated. */
  legacy: string | null
  core: boolean
  rules: boolean
  notebook: boolean
  projects: { name: string; current: boolean; files: number; entries: number; skillFiles: number }[]
  projectSummary: { count: number; files: number; entries: number; skillFiles: number } | null
  currentProject: string | null
  globalMem: { files: number; entries: number; skillFiles: number }
  lastMaintenance: { lastRun: string; project?: string } | null
  activeRuns: number
  configured: { extractor: string; cleaner: string }
}

/** One provider + its models (modelsData). */
export interface MemoryModelProvider {
  id: string
  name: string
  models: { id: string; name?: string }[]
}

/** One subagent run row (runs.js shape). */
export interface MemoryRun {
  id: string
  kind: string
  status: string
  startedAt: string
  endedAt: string | null
  stopReason: string | null
  log?: string[]
}

/** The file tree response (filesData). */
export interface MemoryFileGroup {
  id: string
  label: string
  files: { rel: string; name: string; entries: number }[]
}
export interface MemoryFiles {
  currentProject: string | null
  groups: MemoryFileGroup[]
}

/** The /file GET response. */
export interface MemoryFileContent {
  path: string
  content: string
}

async function memoryFetch<T>(path: string, options?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/hpptools-memory/api/${path}`, options)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  const data = await response.json().catch(() => ({})) as { error?: string } & T
  if (!response.ok) throw new Error((data as { error?: string }).error || `HTTP ${response.status}`)
  return data
}

/** The memory console API surface (plugin-global; no session scope). */
export const memoryApi = {
  overview: (signal?: AbortSignal) =>
    memoryFetch<MemoryOverview>('overview', { cache: 'no-store', signal }),
  models: (signal?: AbortSignal) =>
    memoryFetch<{ configured: { extractor: string; cleaner: string }; providers: MemoryModelProvider[] }>('models', { cache: 'no-store', signal }),
  runs: (signal?: AbortSignal) =>
    memoryFetch<{ runs: MemoryRun[] }>('runs', { cache: 'no-store', signal }),
  files: (signal?: AbortSignal) =>
    memoryFetch<MemoryFiles>('files', { cache: 'no-store', signal }),
  file: (path: string, signal?: AbortSignal) =>
    memoryFetch<MemoryFileContent>(`file?path=${encodeURIComponent(path)}`, { cache: 'no-store', signal }),
  saveFile: (path: string, content: string) =>
    memoryFetch<{ ok: true }>('file', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, content }),
    }),
  setModel: (kind: 'extractor' | 'cleaner', value: string) =>
    memoryFetch<{ value: string }>('model', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, value }),
    }),
  clean: () =>
    memoryFetch<{ ok: true; runId: string }>('clean', { method: 'POST' }),
  migrate: () =>
    memoryFetch<{ copiedItems: number; from: string }>('migrate', { method: 'POST' }),
  saveRoot: (root: string, copyData: boolean) =>
    memoryFetch<{ saved: boolean; root: string; copied: number; restart: boolean }>('settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ root, copyData }),
    }),
  openFolder: (rel: string) =>
    memoryFetch<{ ok: true }>(`open-folder?path=${encodeURIComponent(rel)}`),
}

/** Format an ISO time with the active locale. */
export function formatTime(iso: string | null | undefined, isZh: boolean): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString(isZh ? 'zh-CN' : 'en-US', { hour12: false })
  } catch {
    return new Date(iso).toString()
  }
}

/** Format a duration between two ISO timestamps. */
export function formatDur(startIso: string, endIso: string | null): string {
  const s = new Date(startIso).getTime()
  const e = endIso ? new Date(endIso).getTime() : Date.now()
  const sec = Math.max(0, Math.round((e - s) / 1000))
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  return `${m}m${sec % 60}s`
}
