// @vitest-environment jsdom
/**
 * The shared switch: a controlled checkbox whose writes are asynchronous.
 * A native toggle must not be swallowed by the controlled reset, or a switch
 * turned off can never be turned back on.
 */
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { act } from 'react-dom/test-utils'
import { Switch } from '../src/client/Switch.tsx'
import { renderRoot, setupReactAct } from './test-utils.ts'

setupReactAct()

function Controlled({ initial = true, onChange }: { initial?: boolean; onChange?: (value: boolean) => void }) {
  const [on, setOn] = useState(initial)
  return (
    <Switch
      label="test switch"
      checked={on}
      onChange={(next) => { setOn(next); onChange?.(next) }}
    />
  )
}

describe('Switch', () => {
  it('turns off and back on even when the parent write is asynchronous', () => {
    const changes: boolean[] = []
    const mounted = renderRoot(<Controlled onChange={value => changes.push(value)} />)
    const input = mounted.container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(input.checked).toBe(true)
    const label = mounted.container.querySelector('label') as HTMLLabelElement
    act(() => { label.click() })
    expect(input.checked).toBe(false)
    act(() => { label.click() })
    expect(input.checked).toBe(true)
    // Direct input activation (keyboard Space) takes the same path.
    act(() => { input.click() })
    expect(input.checked).toBe(false)
    act(() => { input.click() })
    expect(input.checked).toBe(true)
    expect(changes).toEqual([false, true, false, true])
    mounted.unmount()
  })
})
