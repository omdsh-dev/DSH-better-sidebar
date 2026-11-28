/** One source-declared filter surface for tab browsing and pack member browsing. */
import { useRef, useState, type ReactNode } from 'react'
import { IconCheckOutlineRegular, IconSlidersTwoOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { ClueSourceDescriptor, JsonObject, JsonValue } from '../../clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../../clues/types.ts'
import { IconButton } from '../ui/kit.tsx'
import { Menu } from '../ui/Menu.tsx'
import { t } from '../locales.ts'
import css from './resource-filters.module.css'

/** The displayed filters and their least restrictive scope, preserving resource identity. */
export function resourceFilterState(source: ClueSourceDescriptor, value: JsonValue | undefined, mode: 'list' | 'search') {
  const filters = source.filters?.filter(filter => filter.appliesTo === undefined || filter.appliesTo === 'both' || filter.appliesTo === mode) ?? []
  const github = source.sourceId === BUILTIN_SOURCE_IDS.githubIssues || source.sourceId === BUILTIN_SOURCE_IDS.githubPulls
  const scope: JsonObject = typeof value === 'string' && github ? { repo: value }
    : value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  const available = !github || (typeof scope.repo === 'string' && scope.repo.trim() !== '')
  const cleared = { ...scope }
  let active = false
  for (const filter of available ? filters : []) {
    const current = filter.options.find(option => JSON.stringify(option.value) === JSON.stringify(scope[filter.scopeKey]))?.id
      ?? filter.defaultOptionId ?? filter.options[0]?.id
    const reset = filter.options.find(option => option.id === 'all')
      ?? filter.options.find(option => option.id === filter.defaultOptionId) ?? filter.options[0]
    if (reset === undefined) continue
    active ||= current !== reset.id
    if (reset.value === undefined) delete cleared[filter.scopeKey]
    else cleared[filter.scopeKey] = reset.value
  }
  return { filters: available ? filters : [], scope, active, clearedScope: Object.keys(cleared).length === 0 ? undefined : cleared }
}

export function ResourceFilters(props: {
  readonly source: ClueSourceDescriptor
  readonly scope: JsonValue | undefined
  readonly mode: 'list' | 'search'
  onChange(scope: JsonValue | undefined): void
}): ReactNode {
  const { filters, scope, active, clearedScope } = resourceFilterState(props.source, props.scope, props.mode)
  const [open, setOpen] = useState(false)
  const [point, setPoint] = useState<{ x: number; y: number } | undefined>(undefined)
  const triggerRef = useRef<HTMLButtonElement>(null)
  if (filters.length === 0) return null
  const optionLabel = (id: string): string => {
    switch (id) {
      case 'all': return t('clueResourceFilterAll')
      case 'active': return t('clueResourceStateActive')
      case 'completed': return t('clueResourceStateCompleted')
      case 'open': return t('clueResourceStateOpen')
      case 'closed': return t('clueResourceStateClosed')
      case 'merged': return t('clueResourceStateMerged')
      case 'draft': return t('clueResourceStateDraft')
      default: return id
    }
  }
  const items: MenuEntry[] = []
  const actions = new Map<string, () => void>()
  filters.forEach((filter, filterIndex) => {
    if (filterIndex > 0) items.push({ type: 'separator', id: `sep-${filter.scopeKey}` })
    const current = filter.options.find(option => JSON.stringify(option.value) === JSON.stringify(scope[filter.scopeKey]))?.id
      ?? filter.defaultOptionId ?? filter.options[0]?.id
    for (const option of filter.options) {
      const id = `${filter.scopeKey}:${option.id}`
      const selected = option.id === current
      items.push({
        id,
        label: optionLabel(option.id),
        icon: selected ? <IconCheckOutlineRegular size={14} /> : undefined,
      })
      actions.set(id, () => {
        const next = { ...scope }
        if (option.value === undefined) delete next[filter.scopeKey]
        else next[filter.scopeKey] = option.value
        props.onChange(Object.keys(next).length === 0 ? undefined : next)
      })
    }
  })
  if (active) {
    items.push({ type: 'separator', id: 'sep-clear' })
    items.push({ id: '__clear', label: t('clueClearFilters') })
    actions.set('__clear', () => { props.onChange(clearedScope) })
  }
  const activeSummary = filters.map(filter => {
    const current = filter.options.find(option => JSON.stringify(option.value) === JSON.stringify(scope[filter.scopeKey]))?.id
      ?? filter.defaultOptionId ?? filter.options[0]?.id
    return current === undefined ? '' : optionLabel(current)
  }).filter(Boolean).join(' · ')
  return (
    <span className={css.filters} data-clue-resource-filters data-filter-active={active ? 'true' : undefined}>
      <IconButton
        ref={triggerRef}
        size="sm"
        active={active}
        label={t('clueResourceFilter')}
        title={activeSummary === '' ? t('clueResourceFilter') : `${t('clueResourceFilter')}: ${activeSummary}`}
        aria-haspopup="menu"
        aria-expanded={open}
        icon={<IconSlidersTwoOutlineRegular size={14} />}
        onClick={() => {
          const rect = triggerRef.current?.getBoundingClientRect()
          setPoint(rect === undefined ? undefined : { x: rect.left, y: rect.bottom })
          setOpen(current => !current)
        }}
      />
      {open && (
        <Menu
          open
          portal
          compact
          autoFocus
          onClose={() => { setOpen(false) }}
          anchorPoint={point}
          anchor={<span />}
          items={items}
          onSelect={(id) => {
            setOpen(false)
            triggerRef.current?.focus()
            actions.get(id)?.()
          }}
        />
      )}
    </span>
  )
}
