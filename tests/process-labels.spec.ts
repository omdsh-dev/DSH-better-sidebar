/**
 * The Tasks page's borrowed main-conversation wording: the live activity line
 * and the settled range title, composed exactly the way the host composes
 * them, plus the fallback that keeps a host rename from printing raw keys.
 */
import { describe, expect, it } from 'vitest'
import { doneActivityTitle, liveActivityLabel, type ChatTranslate } from '../src/client/process-labels.ts'
import type { ProcessActivitySummary } from '../src/process-activity.ts'

/** The host's `chat` dictionary for the keys this module reads (zh wording). */
const HOST: Record<string, string> = {
  'message.stepProcess.thinking': '正在分析请求',
  'message.stepProcess.commands': '正在运行命令',
  'message.stepProcess.read': '正在读取文件',
  'message.stepProcess.tools': '正在调用工具',
  'message.stepProcess.prepare.commands': '准备运行命令',
  'message.stepProcess.prepare.tools': '准备调用工具',
  'message.stepProcess.done.thinking': '已完成分析',
  'message.stepProcess.done.read': '已读取文件',
  'message.stepProcess.done.commands': '执行了命令',
  'message.stepProcess.done.search': '已搜索代码',
  'message.stepProcess.done.tools': '已调用工具',
  'message.stepProcess.joinTwo': '{first}并{second}',
  'message.stepProcess.comma': '，',
  'message.stepProcess.sharedPrefix': '已',
  'message.stepProcess.more': '{title}等',
  'message.turnProcess.separator': ' · ',
}

/** The host translator, with `{name}` interpolation like DSH's own. */
const t: ChatTranslate = (key, params) => {
  const template = HOST[key]
  if (template === undefined) return undefined
  if (params === undefined) return template
  let text = template
  for (const [name, value] of Object.entries(params)) text = text.replaceAll(`{${name}}`, String(value))
  return text
}

/** A summary built from counts. */
function summary(over: Partial<ProcessActivitySummary> = {}): ProcessActivitySummary {
  return { counts: [], runningDetail: '', ...over }
}

describe('live activity label', () => {
  it('renders the category wording plus the running detail', () => {
    expect(liveActivityLabel(summary({
      counts: [{ kind: 'commands', count: 2 }],
      running: 'commands',
      runningDetail: 'npm run build',
    }), t)).toBe('正在运行命令 · npm run build')
  })

  it('falls back to the host thinking wording while nothing is dispatched', () => {
    expect(liveActivityLabel(summary({ counts: [{ kind: 'read', count: 1 }] }), t)).toBe('正在分析请求')
    expect(liveActivityLabel(undefined, t)).toBe('正在分析请求')
  })

  it('uses the prepare wording without a detail', () => {
    expect(liveActivityLabel(summary({
      running: 'commands',
      runningDetail: 'ignored while preparing',
      preparing: true,
    }), t)).toBe('准备运行命令')
  })

  it('answers undefined when the host namespace is unavailable', () => {
    const missing: ChatTranslate = () => undefined
    expect(liveActivityLabel(summary({ running: 'commands' }), missing)).toBeUndefined()
    // …and falls back to the detail it does have when the host has one.
    expect(liveActivityLabel(summary({ running: 'commands', runningDetail: 'npm test' }), missing))
      .toBe('npm test')
  })
})

describe('settled range title', () => {
  it('prints one category without counts', () => {
    expect(doneActivityTitle(summary({ counts: [{ kind: 'read', count: 3 }] }), t)).toBe('已读取文件')
  })

  it('joins two categories and drops the shared prefix from the second', () => {
    expect(doneActivityTitle(summary({
      counts: [{ kind: 'read', count: 2 }, { kind: 'search', count: 1 }],
    }), t)).toBe('已读取文件并搜索代码')
  })

  it('joins three categories with the host comma', () => {
    expect(doneActivityTitle(summary({
      counts: [
        { kind: 'read', count: 3 },
        { kind: 'search', count: 2 },
        { kind: 'commands', count: 1 },
      ],
    }), t)).toBe('已读取文件，已搜索代码，执行了命令')
  })

  it('appends the host suffix beyond the top three', () => {
    const title = doneActivityTitle(summary({
      counts: [
        { kind: 'read', count: 4 },
        { kind: 'search', count: 3 },
        { kind: 'commands', count: 2 },
        { kind: 'tools', count: 1 },
      ],
    }), t)
    // The host lowercases the continuation labels but only the TWO-label
    // branch strips the shared "已" prefix, so these keep it.
    expect(title).toBe('已读取文件，已搜索代码，执行了命令等')
  })

  it('answers the host thinking wording when nothing was called', () => {
    expect(doneActivityTitle(summary(), t)).toBe('已完成分析')
    expect(doneActivityTitle(undefined, t)).toBe('已完成分析')
  })

  it('answers undefined when a category has no host wording', () => {
    const partial: ChatTranslate = key => (key === 'message.stepProcess.done.read' ? '已读取文件' : undefined)
    expect(doneActivityTitle(summary({ counts: [{ kind: 'read', count: 1 }, { kind: 'commands', count: 1 }] }), partial))
      .toBeUndefined()
    expect(doneActivityTitle(summary({ counts: [{ kind: 'read', count: 1 }] }), partial)).toBe('已读取文件')
  })
})
