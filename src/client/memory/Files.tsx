/**
 * Memory files: the memory vault tree (core / notebook / global / project
 * groups, collapsible — rows reuse the explorer row chrome) plus a Markdown
 * preview / edit pane with a section navigator. Reads and writes through the
 * hpptools-memory file routes.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconBrowseOutline16, IconCheckOutline16, IconCloseOutline16, IconCodeOutline16,
  IconEditOutline16, IconListPenOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { memoryApi, type MemoryFiles } from './api.ts'
import { t } from '../locales.ts'
import type { SessionScope } from '../service.ts'
import shellCss from '../sidebar.module.css'
import css from '../memory.module.css'

type Mode = 'preview' | 'edit' | 'previewing'

const COLLAPSED_KEY = 'hpptools-tree-collapsed'

function defaultCollapsed(id: string): boolean {
  return id === 'personal' || id.startsWith('project:')
}

function readCollapsed(): string[] | null {
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY)
    if (raw) { const arr = JSON.parse(raw) as unknown; if (Array.isArray(arr)) return arr as string[] }
  } catch { /* ignore */ }
  return null
}

/** DSH icon for a memory vault file (size 14, matching explorer row chrome). */
function fileIcon(rel: string): ReactNode {
  if (rel.endsWith('.md')) return <IconListPenOutline16 size={14} />
  if (rel.endsWith('.txt')) return <IconCodeOutline16 size={14} />
  return <IconCodeOutline16 size={14} />
}

// ---- lightweight Markdown rendering (titles / code / bold / italic / links / lists / quotes / wikilinks) ----
function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ))
}

function inlineMd(text: string): string {
  let s = escapeHtml(text)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/\[\[([^\]]+)\]\]/g, `<span class="${css.memWl}">[[$1]]</span>`)
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  return s
}

function renderMarkdown(md: string): string {
  const lines = (md || '').split('\n')
  const out: string[] = []
  let inCode = false
  let h2Seq = 0
  const codeBuf: string[] = []
  const flushCode = (): void => {
    if (inCode) {
      out.push(`<pre><code>${escapeHtml(codeBuf.join('\n'))}</code></pre>`)
      codeBuf.length = 0
      inCode = false
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      flushCode(); inCode = !inCode
      continue
    }
    if (inCode) { codeBuf.push(raw); continue }
    if (!line) { out.push(''); continue }
    if (/^#{1,4}\s/.test(line)) {
      const heading = line.match(/^(#{1,4})\s/)!
      const level = heading[1]!.length
      if (level === 2) {
        h2Seq++
        out.push(`<h2 data-sec="${h2Seq}">${inlineMd(line.replace(/^#{1,4}\s*/, ''))}</h2>`)
      } else {
        out.push(`<h${level}>${inlineMd(line.replace(/^#{1,4}\s*/, ''))}</h${level}>`)
      }
    } else if (/^---+$/.test(line)) {
      out.push('<hr>')
    } else if (/^>\s/.test(line)) {
      out.push(`<blockquote>${inlineMd(line.replace(/^>\s?/, ''))}</blockquote>`)
    } else if (/^[-*]\s+/.test(line)) {
      out.push(`<li>${inlineMd(line.replace(/^[-*]\s+/, ''))}</li>`)
    } else if (/^\d+[.)]\s+/.test(line)) {
      out.push(`<li>${inlineMd(line.replace(/^\d+[.)]\s+/, ''))}</li>`)
    } else {
      out.push(`<p>${inlineMd(line)}</p>`)
    }
  }
  flushCode()
  return out.join('\n')
}

export function Files({ visible, scope }: { visible: boolean; scope?: SessionScope }) {
  const [files, setFiles] = useState<MemoryFiles | null>(null)
  const [collapsed, setCollapsed] = useState<string[] | null>(readCollapsed())
  const [current, setCurrent] = useState<{ rel: string; content: string } | null>(null)
  const [mode, setMode] = useState<Mode>('preview')
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<{ msg: string; kind?: string }>({ msg: t('memSelectHint') })
  const [busy, setBusy] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const sessionId = scope?.sessionId

  const loadFiles = useCallback((): void => {
    memoryApi.files(sessionId).then(setFiles).catch((e: unknown) => {
      setStatus({ msg: `❌ ${e instanceof Error ? e.message : String(e)}`, kind: 'err' })
    })
  }, [sessionId])

  useEffect(() => { loadFiles() }, [loadFiles])

  // 文件树自动刷新：对话进行中会不断产生新的 raw-<n>.md / 更新
  // dialogue-summary.md——可见时每 3 秒轮询一次，让新文件自动出现
  // （不打断编辑/预览：文件树与内容区状态独立）。
  useEffect(() => {
    if (!visible) return
    const timer = setInterval(loadFiles, 3000)
    return () => clearInterval(timer)
  }, [visible, loadFiles])

  const toggleGroup = (id: string): void => {
    const arr = collapsed ?? []
    const next = arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]
    setCollapsed(next)
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  }

  const selectFile = (rel: string): void => {
    setBusy(true)
    memoryApi.file(rel).then((d) => {
      setCurrent({ rel, content: d.content })
      setDraft(d.content)
      setMode('preview')
      setStatus({ msg: t('memLoaded', { n: d.content.split('\n').length }) })
    }).catch((e: unknown) => {
      setStatus({ msg: `❌ ${e instanceof Error ? e.message : String(e)}`, kind: 'err' })
    }).finally(() => setBusy(false))
  }

  const saveFile = (): void => {
    if (current === null) return
    setBusy(true)
    const ta = contentRef.current?.querySelector('textarea')
    const content = mode === 'edit' ? (ta ? ta.value : draft) : draft
    memoryApi.saveFile(current.rel, content).then(() => {
      setCurrent({ ...current, content })
      setDraft(content)
      setMode('preview')
      setStatus({ msg: t('memSaved', { path: current.rel }), kind: 'ok' })
      loadFiles()
    }).catch((e: unknown) => {
      setStatus({ msg: `❌ ${e instanceof Error ? e.message : String(e)}`, kind: 'err' })
    }).finally(() => setBusy(false))
  }

  // section navigator (## headings)
  const sections: { title: string; seq: number }[] = []
  if (current !== null) {
    let seq = 0
    for (const line of current.content.split('\n')) {
      if (line.startsWith('## ')) sections.push({ title: line.slice(3).trim(), seq: ++seq })
    }
  }

  const src = mode === 'preview' ? (current?.content ?? '') : draft
  const superseded = (title: string): boolean => /Superseded|被取代/.test(title)

  return (
    <div className={css.memFiles}>
      <div className={css.memTree}>
        {files === null && <div className={css.memEmpty}>{t('memLoading')}</div>}
        {files?.groups.map((g) => {
          const isCollapsed = collapsed !== null ? collapsed.includes(g.id) : defaultCollapsed(g.id)
          return (
            <div key={g.id}>
              <button type="button" className={css.memTreeGroupHead} onClick={() => toggleGroup(g.id)}>
                <span style={{ width: 10, flex: 'none', fontSize: 9 }}>{isCollapsed ? '▸' : '▾'}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.label}</span>
                {g.files.length > 0 && <span className={css.memTreeCount}>{g.files.length}</span>}
              </button>
              {!isCollapsed && (
                <div>
                  {g.files.length === 0
                    ? <div className={css.memEmpty}>{t('memEmptyGroup')}</div>
                    : g.files.map((f) => (
                      <button
                        key={f.rel}
                        type="button"
                        className={shellCss.explorerRow + (current?.rel === f.rel ? ' ' + css.memTreeItemActive : '')}
                        title={f.rel}
                        onClick={() => selectFile(f.rel)}
                      >
                        <span style={{ flex: 'none', display: 'inline-flex', alignItems: 'center' }}>{fileIcon(f.rel)}</span>
                        <span className={shellCss.explorerName} style={{ flex: 1 }}>{f.name}</span>
                        {f.entries > 0 && <span className={css.memTreeCount}>{f.entries}</span>}
                      </button>
                    ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className={css.memFilePane}>
        <div className={css.memFileHead}>
          <span className={css.memFileTitle}>{current?.rel ?? ''}</span>
          <span style={{ flex: 1 }} />
          {current !== null && (
            <>
              {mode === 'preview'
                ? <button type="button" className={shellCss.iconButton} title={t('memEdit')} onClick={() => { setDraft(current.content); setMode('edit') }}><IconEditOutline16 /></button>
                : <button type="button" className={shellCss.iconButton} title={t('memPreview')} onClick={() => setMode('previewing')}><IconBrowseOutline16 /></button>
              }
              {mode !== 'preview' && (
                <>
                  <button type="button" className={shellCss.iconButton} disabled={busy} title={t('memSave')} onClick={saveFile} style={{ color: 'var(--dsw-alias-state-success-primary)' }}><IconCheckOutline16 /></button>
                  <button type="button" className={shellCss.iconButton} title={t('memCancel')} onClick={() => { setMode('preview'); setDraft(current.content) }}><IconCloseOutline16 /></button>
                </>
              )}
            </>
          )}
        </div>

        <div className={css.memFileBody}>
          <div className={css.memFileContent} ref={contentRef}>
            {current === null
              ? <div className={css.memEmpty}>{t('memSelectHint')}</div>
              : mode === 'edit'
                ? <textarea value={draft} onChange={(e) => setDraft(e.target.value)} className={css.memTextarea} />
                : <div className={css.memMd} dangerouslySetInnerHTML={{ __html: renderMarkdown(src) }} />
            }
          </div>
          {current !== null && mode === 'preview' && sections.length >= 2 && (
            <div className={css.memEntryNav}>
              <h4 className={css.memEntryNavHead}>{t('memEntryNav')}</h4>
              {sections.map((s) => (
                <button
                  key={s.seq}
                  type="button"
                  className={css.memEntryItem + (superseded(s.title) ? ' ' + css.memEntrySup : '')}
                  title={s.title}
                  onClick={() => {
                    const el = contentRef.current?.querySelector(`h2[data-sec="${s.seq}"]`)
                    el?.scrollIntoView({ block: 'center' })
                  }}
                >
                  {s.title}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className={css.memStatus + (status.kind === 'ok' ? ' ' + css.memStatusOk : status.kind === 'err' ? ' ' + css.memStatusErr : '')}>
          {status.msg}
        </div>
      </div>
    </div>
  )
}
