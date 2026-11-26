// @vitest-environment jsdom
/**
 * The shared toggle switch (ui/controls `ToggleSwitch`): a button with
 * `role="switch"` whose next value derives from the controlled PROP. The
 * parent's write is asynchronous, so a switch turned off must be able to turn
 * back on even when the controlled value is reset before React's handler runs
 * (the failure the old custom checkbox switch was built to avoid).
 */
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { ToggleSwitch } from '../src/client/ui/index.ts'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

function Controlled({ initial = true, onChange }: { initial?: boolean; onChange?: (value: boolean) => void }) {
  const [on, setOn] = useState(initial)
  return (
    <ToggleSwitch
      aria-label="test switch"
      checked={on}
      onChange={(next) => { setOn(next); onChange?.(next) }}
    />
  )
}

describe('ToggleSwitch', () => {
  it('turns off and back on even when the parent write is asynchronous', () => {
    const changes: boolean[] = []
    const mounted = renderRoot(<Controlled onChange={value => changes.push(value)} />)
    const toggle = mounted.container.querySelector('[role="switch"]') as HTMLElement
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    act(() => { toggle.click() })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    act(() => { toggle.click() })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    act(() => { toggle.click() })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(changes).toEqual([false, true, false])
    mounted.unmount()
  })
})
