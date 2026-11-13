/** One source-declared filter surface for tab browsing and pack member browsing. */
import type { ReactNode } from 'react'
import type { ClueSourceDescriptor, JsonObject, JsonValue } from '../../clues/types.ts'
import { BUILTIN_SOURCE_IDS } from '../../clues/types.ts'
import { SelectMenu } from '../ui/SelectMenu.tsx'
import { ActionButton } from '../ui/kit.tsx'
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
  return <div className={css.filters} data-clue-resource-filters>
    {filters.map(filter => {
      const current = filter.options.find(option => JSON.stringify(option.value) === JSON.stringify(scope[filter.scopeKey]))?.id
        ?? filter.defaultOptionId ?? filter.options[0]?.id
      return <div key={filter.scopeKey} className={css.filter}>
        <SelectMenu ariaLabel={t('clueResourceFilter')} value={current ?? ''}
          options={filter.options.map(option => ({ value: option.id, label: optionLabel(option.id) }))}
          onChange={(value: string) => {
            const option = filter.options.find(option => option.id === value)
            if (option === undefined) return
            const next = { ...scope }
            if (option.value === undefined) delete next[filter.scopeKey]
            else next[filter.scopeKey] = option.value
            props.onChange(Object.keys(next).length === 0 ? undefined : next)
          }} />
      </div>
    })}
    {active && <ActionButton variant="ghost" onClick={() => { props.onChange(clearedScope) }}>{t('clueClearFilters')}</ActionButton>}
  </div>
}
