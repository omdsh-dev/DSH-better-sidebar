import { describe, expect, it } from 'vitest'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SidebarSessionEvent } from '../src/context-types.ts'
import { advancePreviewWriteCursor, hasCompletedPreviewWrite, INITIAL_PREVIEW_WRITE_CURSOR } from '../src/client/editor-auto-refresh.ts'

/** 生成会话日志中真实的文件工具调用事件。 */
function call(seq: number, callId: string, name: string, path: string): SidebarSessionEvent {
  return { seq, time: seq, type: 'tool/call', data: { callId, name, arguments: JSON.stringify({ file_path: path }) } }
}

/** 使用 DSH 的消息构造器生成工具结果事件。 */
function result(seq: number, callId: string, isError = false): SidebarSessionEvent {
  const message = createToolResultMessage({ callId: ToolCallId(callId), content: [{ type: 'text', text: isError ? 'failed' : 'done' }], isError })
  return { seq, time: seq, type: 'tool/result', data: { message } }
}

describe('编辑器自动刷新信号', () => {
  it('初次读取只建立基线，后续成功结果仅触发一次', () => {
    const initial = [call(0, 'history', 'write', 'a.ts'), result(1, 'history'), call(2, 'current', 'edit', 'a.ts')]
    const baseline = advancePreviewWriteCursor(INITIAL_PREVIEW_WRITE_CURSOR, { events: initial, lastSeq: 2 }, '/workspace', '/workspace/a.ts')
    expect(baseline.changed).toBe(false)
    const completed = advancePreviewWriteCursor(baseline.cursor, { events: [result(3, 'current')], lastSeq: 3 }, '/workspace', '/workspace/a.ts')
    expect(completed.changed).toBe(true)
    expect(advancePreviewWriteCursor(completed.cursor, { events: [], lastSeq: 3 }, '/workspace', '/workspace/a.ts').changed).toBe(false)
  })

  it('游标为零时忽略重复下发的旧事件', () => {
    const initial = [call(0, 'old', 'write', 'a.ts')]
    const baseline = advancePreviewWriteCursor(INITIAL_PREVIEW_WRITE_CURSOR, { events: initial, lastSeq: 0 }, '/workspace', '/workspace/a.ts')
    const repeated = advancePreviewWriteCursor(baseline.cursor, { events: initial, lastSeq: 0 }, '/workspace', '/workspace/a.ts')
    expect(repeated.changed).toBe(false)
    expect(repeated.cursor.events).toHaveLength(1)
    expect(advancePreviewWriteCursor(repeated.cursor, { events: [...initial, result(1, 'old')], lastSeq: 1 }, '/workspace', '/workspace/a.ts').changed).toBe(true)
  })

  it('成功写入当前文件时命中，历史结果不会再次命中', () => {
    const events = [call(1, 'write-a', 'write', './src/a.ts'), result(2, 'write-a')]
    expect(hasCompletedPreviewWrite(events, events.slice(1), '/workspace', '/workspace/src/a.ts')).toBe(true)
    expect(hasCompletedPreviewWrite(events, [], '/workspace', '/workspace/src/a.ts')).toBe(false)
  })

  it('成功编辑当前文件时命中，其他文件和读取操作不会命中', () => {
    const events = [
      call(1, 'edit-a', 'edit', 'src/../src/a.ts'), result(2, 'edit-a'),
      call(3, 'write-b', 'write', 'src/b.ts'), result(4, 'write-b'),
      call(5, 'read-a', 'read', 'src/a.ts'), result(6, 'read-a'),
    ]
    expect(hasCompletedPreviewWrite(events, [events[1]!], '/workspace', '/workspace/src/a.ts')).toBe(true)
    expect(hasCompletedPreviewWrite(events, [events[3]!, events[5]!], '/workspace', '/workspace/src/a.ts')).toBe(false)
  })

  it('失败和仍在执行的文件操作不会命中', () => {
    const events = [call(1, 'failed', 'write', 'a.ts'), result(2, 'failed', true), call(3, 'running', 'edit', 'a.ts')]
    expect(hasCompletedPreviewWrite(events, [events[1]!], '/workspace', '/workspace/a.ts')).toBe(false)
    expect(hasCompletedPreviewWrite(events, [events[2]!], '/workspace', '/workspace/a.ts')).toBe(false)
  })

  it('Windows 路径按盘符和分隔符比较', () => {
    const events = [call(1, 'windows', 'write', 'src\\a.ts'), result(2, 'windows')]
    expect(hasCompletedPreviewWrite(events, [events[1]!], 'C:\\Workspace', 'c:/workspace/src/a.ts')).toBe(true)
  })
})
