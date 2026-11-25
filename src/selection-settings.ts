/** One persisted selection-menu document, shared by settings and the lazy editor. */
export const REWRITE_ACTIONS = ['expand', 'humanize', 'shorten', 'continue'] as const
export type RewriteAction = typeof REWRITE_ACTIONS[number]
export type SelectionMenuItem = 'rewrite' | 'translate'
export interface CustomSelectionAction { id: string; name: string; prompt: string }
export interface SelectionSettings {
  enabled: boolean
  autoRun: boolean
  disabled: Record<string, boolean>
  menuOrder: SelectionMenuItem[]
  rewriteOrder: string[]
  prompts: Record<string, string>
  customActions: CustomSelectionAction[]
  translationLanguage: string
  translationModel: string
}
export const REWRITE_PROMPTS: Record<RewriteAction, string> = {
  expand: 'Expand the selected passage with useful detail consistent with its context. Do not invent facts.',
  humanize: 'Rewrite the selected passage in natural, specific language. Remove formulaic AI phrasing while preserving its meaning, facts and tone.',
  shorten: 'Shorten the selected passage while retaining its important facts and meaning.',
  continue: 'Continue writing after the selected passage, matching its context and style. Preserve existing content and do not invent facts.',
}
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
/** Normalize unknown persisted input once; old/removed action IDs do not survive. */
export function selectionSettingsOf(prefs: { pluginSettings?: Record<string, Record<string, unknown>> }): SelectionSettings {
  const raw = object(prefs.pluginSettings?.clues?.selection)
  const customs: CustomSelectionAction[] = []
  const ids = new Set<string>()
  if (Array.isArray(raw.customActions)) for (const value of raw.customActions.slice(0, 20)) {
    const item = object(value)
    if (typeof item.id !== 'string' || !/^custom-[A-Za-z0-9_-]+$/u.test(item.id) || ids.has(item.id)
      || typeof item.name !== 'string' || item.name.trim() === '' || typeof item.prompt !== 'string' || item.prompt.trim() === '') continue
    ids.add(item.id)
    customs.push({ id: item.id, name: item.name.slice(0, 100), prompt: item.prompt.slice(0, 8192) })
  }
  const all = [...REWRITE_ACTIONS, ...customs.map(item => item.id)]
  const order = <T extends string>(value: unknown, defaults: readonly T[]): T[] => [...new Set([
    ...(Array.isArray(value) ? value.filter((id): id is T => typeof id === 'string' && defaults.includes(id as T)) : []), ...defaults,
  ])]
  return {
    enabled: raw.enabled !== false,
    autoRun: raw.autoRun !== false,
    disabled: Object.fromEntries(Object.entries(object(raw.disabled)).filter(([, value]) => value === true)) as Record<string, boolean>,
    menuOrder: order(raw.menuOrder, ['rewrite', 'translate']),
    rewriteOrder: order(raw.rewriteOrder, all),
    prompts: Object.fromEntries(Object.entries(object(raw.prompts)).filter(([id, value]) => REWRITE_ACTIONS.includes(id as RewriteAction) && typeof value === 'string').map(([id, value]) => [id, (value as string).slice(0, 8192)])),
    customActions: customs,
    translationLanguage: typeof raw.translationLanguage === 'string' ? raw.translationLanguage.slice(0, 100) : '',
    translationModel: typeof raw.translationModel === 'string' ? raw.translationModel.slice(0, 500) : '',
  }
}
export function selectionPrompt(settings: SelectionSettings, id: string): string {
  return settings.customActions.find(item => item.id === id)?.prompt
    ?? settings.prompts[id] ?? REWRITE_PROMPTS[id as RewriteAction] ?? ''
}
