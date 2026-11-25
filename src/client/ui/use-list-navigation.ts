import { useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react'

/**
 * One title Tab entry in a native list; other controls keep their native Tab order.
 * Pass stable item keys in DOM order, mark each title with data-list-primary,
 * and spread the handlers/ref onto the list. No roles or observers are added.
 */
export function useListNavigation<T extends HTMLElement = HTMLUListElement>(itemKeys: readonly string[]) {
  const ref = useRef<T>(null)
  const [currentKey, setCurrentKey] = useState<string | undefined>(() => itemKeys[0])
  const entryKey = currentKey !== undefined && itemKeys.includes(currentKey) ? currentKey : itemKeys[0]

  const primaryOf = (target: EventTarget): HTMLElement | null => {
    if (!(target instanceof Element)) return null
    const primary = target.closest<HTMLElement>('[data-list-primary]')
    return primary !== null && ref.current?.contains(primary) ? primary : null
  }

  const remember = (target: EventTarget): void => {
    const primary = primaryOf(target)
    if (primary === null) return
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[data-list-primary]') ?? [])]
    const key = itemKeys[items.indexOf(primary)]
    if (key !== undefined) setCurrentKey(key)
  }

  const onKeyDown = (event: KeyboardEvent<T>): void => {
    if (event.repeat || event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey) return
    if (event.target instanceof Element
      && event.target.closest('input, textarea, select, [contenteditable="true"]') !== null) return
    const primary = primaryOf(event.target)
    if (primary === null) return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-list-primary]')]
    const index = items.indexOf(primary)
    let next: number
    switch (event.key) {
      case 'ArrowDown': next = Math.min(index + 1, items.length - 1); break
      case 'ArrowUp': next = Math.max(index - 1, 0); break
      case 'Home': next = 0; break
      case 'End': next = items.length - 1; break
      default: return
    }
    const target = items[next]
    if (target === undefined) return
    event.preventDefault()
    target.focus({ preventScroll: true })
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const onFocusCapture = (event: FocusEvent<T>): void => { remember(event.target) }
  // Safari can click a button without focusing it; its title still becomes the entry.
  const onClickCapture = (event: MouseEvent<T>): void => { remember(event.target) }

  return {
    ref,
    onKeyDown,
    onFocusCapture,
    onClickCapture,
    itemTabIndex: (index: number): 0 | -1 => itemKeys[index] !== undefined && itemKeys[index] === entryKey ? 0 : -1,
  }
}
