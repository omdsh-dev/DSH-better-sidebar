/**
 * The MCP panel (issue #276): the live roster of connected MCP servers and
 * their tools. The data is derived host-side from the tool registry — a
 * server's tools are unregistered when the connection drops, so the list is
 * truthful by construction (see src/mcp-status.ts). The harness pushes no
 * MCP status events, so refresh is manual + on mount/focus (the git panel's
 * KISS policy).
 */
import { useCallback, useEffect, useState } from 'react'
import { IconRefreshOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { McpStatusResult } from './api.ts'
import { api } from './api.ts'
import { t } from './locales.ts'
import css from './sidebar.module.css'

export function McpView(props: { visible: boolean }) {
  const { visible } = props
  const [status, setStatus] = useState<McpStatusResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.mcpStatus())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }, [])

  // Refresh on mount and whenever the tab becomes visible again (MCP
  // connections change while the tab is hidden; re-poll on focus).
  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])

  return (
    <div className={css.mcp}>
      <div className={css.mcpHeader}>
        <span className={css.mcpTitle}>{t('mcp')}</span>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('refresh')}
          title={t('refresh')}
          onClick={() => { void refresh() }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>

      {loading && status === null && <div className={css.mcpPlaceholder}>{t('loading')}</div>}
      {!loading && error !== null && status === null && <div className={css.mcpError}>{error}</div>}

      {status !== null && status.servers.length === 0 && (
        <div className={css.mcpPlaceholder}>{t('mcpEmpty')}</div>
      )}

      {status !== null && status.servers.length > 0 && (
        <div className={css.mcpServers}>
          {status.servers.map(server => (
            <section key={server.name} className={css.mcpServer}>
              <header className={css.mcpServerHeader}>
                <span className={css.mcpServerName}>{server.name}</span>
                <span className={css.mcpServerCount}>{server.tools.length}</span>
              </header>
              <ul className={css.mcpToolList}>
                {server.tools.map(tool => (
                  <li key={tool.name} className={css.mcpTool}>
                    <span className={css.mcpToolName}>{tool.name}</span>
                    {tool.description !== undefined && tool.description !== '' && (
                      <span className={css.mcpToolDesc}>{tool.description}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
