/**
 * Terminal shell candidates: the pure transform behind the settings panel
 * (src/terminal-shells.ts). The route that performs the one `edit()` call is
 * covered by the panel spec end to end, so the contracts here are the data
 * rules — the ones a wrong answer would silently break.
 *
 * Three of them matter most:
 *
 * 1. THE NATIVE SET IS RESTATED. A profile `shellCandidates` override REPLACES
 *    the whole array rather than extending it, so every write has to name the
 *    six defaults again. A transform that appended only the new value would
 *    delete five working shells from the user's list on the first add.
 * 2. NATIVE CANDIDATES ARE NOT REMOVABLE. They are the host's own defaults;
 *    hiding one is not something the panel offers, and a request that tries
 *    must be refused rather than quietly honoured.
 * 3. BAD INPUT IS REFUSED BEFORE ANY WRITE. `applyCandidateAction` throws so the
 *    route can answer a 400; throwing inside `edit()`'s callback would report a
 *    failed write for a request that never had to reach the document.
 */
import { describe, expect, it } from 'vitest'
import {
  applyCandidateAction,
  candidateView,
  DEFAULT_SHELL_CANDIDATES,
  readCandidates,
  TERMINAL_CONTROLLER_ENTRY,
  shellKeyOf,
  uniqueShells,
} from '../src/terminal-shells.ts'

describe('terminal shell candidates: the native set', () => {
  it('names the loader row the terminal controller reads', () => {
    expect(TERMINAL_CONTROLLER_ENTRY).toBe('terminal-controller')
  })

  it('declares exactly the host defaults, in the host order', () => {
    // These are `Config.shellCandidates` in the terminal controller: the order
    // is the order the host discovers them in, so it is part of the value.
    expect([...DEFAULT_SHELL_CANDIDATES]).toEqual(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd'])
  })
})

describe('terminal shell candidates: reading a row', () => {
  it('treats an absent or non-array field as "no override"', () => {
    expect(readCandidates({})).toEqual([])
    expect(readCandidates({ shellCandidates: null })).toEqual([])
    expect(readCandidates({ shellCandidates: 'bash' })).toEqual([])
    // A hand-edited document can hold anything; only strings are names.
    expect(readCandidates({ shellCandidates: ['nu', 7, null, 'elvish'] })).toEqual(['nu', 'elvish'])
  })

  it('splits declared names into native (hidden) and custom (shown)', () => {
    const view = candidateView(
      { documentPath: '/home/u/.dsh/profiles/web/cordis.patch.yml' },
      { shellCandidates: ['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd', 'nu', 'elvish'] },
    )
    // `native` is the DEFAULT set, not what the document repeats: the panel
    // always offers the host defaults, whether or not this profile overrides.
    expect(view.native).toEqual(['zsh', 'bash', 'fish', 'pwsh', 'powershell', 'cmd'])
    expect(view.custom).toEqual(['nu', 'elvish'])
    expect(view.documentPath).toBe('/home/u/.dsh/profiles/web/cordis.patch.yml')
  })

  it('shows no custom names for a row that only restates the defaults', () => {
    const view = candidateView({ documentPath: 'p' }, { shellCandidates: [...DEFAULT_SHELL_CANDIDATES] })
    expect(view.custom).toEqual([])
  })

  it('shows no custom names for a row with no override at all', () => {
    expect(candidateView({ documentPath: 'p' }, {}).custom).toEqual([])
  })
})

describe('terminal shell candidates: shellKeyOf', () => {
  it('reduces a name and a path to the key the host compares on', () => {
    // The host's own rule (`shellKind`): basename, no `.exe`, lower-cased. Both
    // spellings must land on the same key, or a default stored as one can never
    // match a candidate written as the other.
    expect(shellKeyOf('bash')).toBe('bash')
    expect(shellKeyOf('bash.exe')).toBe('bash')
    expect(shellKeyOf('/usr/bin/bash')).toBe('bash')
    expect(shellKeyOf('C:\\Program Files\\Git\\bin\\bash.exe')).toBe('bash')
    expect(shellKeyOf('PowerShell')).toBe('powershell')
    expect(shellKeyOf('  nu  ')).toBe('nu')
    expect(shellKeyOf('')).toBe('')
  })
})

describe('terminal shell candidates: uniqueShells', () => {
  it('trims, drops blanks and keeps first occurrences in order', () => {
    expect(uniqueShells([' bash ', '', '  ', 'nu', 'elvish'])).toEqual(['bash', 'nu', 'elvish'])
  })

  it('collapses spellings the host treats as one shell', () => {
    // `bash`, `bash.exe` and `/usr/bin/bash` are one executable to the host, so
    // listing all three would give the user three identical menu rows. The
    // FIRST spelling wins: it is the one the user typed.
    expect(uniqueShells(['bash', 'bash.exe', '/usr/bin/bash', 'nu'])).toEqual(['bash', 'nu'])
  })
})

describe('terminal shell candidates: adding', () => {
  it('restates every default before the new name', () => {
    const next = applyCandidateAction({}, 'addCandidate', 'nu')
    expect(next.shellCandidates).toEqual([...DEFAULT_SHELL_CANDIDATES, 'nu'])
  })

  it('keeps a previous override instead of replacing it', () => {
    const next = applyCandidateAction({ shellCandidates: ['nu'] }, 'addCandidate', 'elvish')
    // The names are re-normalized on the way out — a document that already lost
    // a default gets it back rather than inheriting the loss.
    expect(next.shellCandidates).toEqual([...DEFAULT_SHELL_CANDIDATES, 'nu', 'elvish'])
  })

  it('is idempotent for a name that is already listed', () => {
    const once = applyCandidateAction({}, 'addCandidate', 'nu')
    const twice = applyCandidateAction(once, 'addCandidate', 'nu')
    expect(twice.shellCandidates).toEqual([...DEFAULT_SHELL_CANDIDATES, 'nu'])
  })

  it('never mutates the config it was handed', () => {
    const current = { shellCandidates: ['nu'], other: 'kept' }
    applyCandidateAction(current, 'addCandidate', 'elvish')
    expect(current).toEqual({ shellCandidates: ['nu'], other: 'kept' })
  })

  it('preserves unrelated config fields', () => {
    // The row also carries `shell` (the pinned default) and whatever else the
    // user set; a candidate edit must not drop them.
    const next = applyCandidateAction({ shell: { path: '/bin/zsh' }, shellCandidates: [] }, 'addCandidate', 'nu')
    expect(next.shell).toEqual({ path: '/bin/zsh' })
  })

  it('refuses a blank name', () => {
    expect(() => applyCandidateAction({}, 'addCandidate', '  ')).toThrow(/shell name is required/)
    expect(() => applyCandidateAction({}, 'addCandidate', 7)).toThrow(/shell name is required/)
  })
})

describe('terminal shell candidates: removing', () => {
  it('drops a custom name and still restates the defaults', () => {
    const next = applyCandidateAction({ shellCandidates: [...DEFAULT_SHELL_CANDIDATES, 'nu', 'elvish'] }, 'removeCandidate', 'nu')
    expect(next.shellCandidates).toEqual([...DEFAULT_SHELL_CANDIDATES, 'elvish'])
  })

  it('refuses to remove a built-in candidate', () => {
    // Hiding a host default is not a control the panel offers, and honouring it
    // here would remove a shell the user never asked to hide.
    expect(() => applyCandidateAction({}, 'removeCandidate', 'bash'))
      .toThrow(/"bash" is a built-in candidate and cannot be removed/)
    for (const name of DEFAULT_SHELL_CANDIDATES) {
      expect(() => applyCandidateAction({}, 'removeCandidate', name)).toThrow(/built-in candidate/)
    }
    // A default reaches the same list through another spelling: the candidate
    // box accepts absolute paths, so `C:\\Windows\\system32\\cmd.exe` names the
    // same built-in and must be refused too.
    expect(() => applyCandidateAction({}, 'removeCandidate', 'C:\\Windows\\system32\\cmd.exe'))
      .toThrow(/built-in candidate/)
  })

  it('removes a custom candidate named by a different spelling', () => {
    const next = applyCandidateAction({ shellCandidates: [...DEFAULT_SHELL_CANDIDATES, 'nu'] }, 'removeCandidate', 'nu.exe')
    expect(next.shellCandidates).toEqual([...DEFAULT_SHELL_CANDIDATES])
  })

  it('refuses a blank name', () => {
    expect(() => applyCandidateAction({}, 'removeCandidate', '')).toThrow(/shell name is required/)
  })
})

describe('terminal shell candidates: unknown requests', () => {
  it('refuses an action it does not implement', () => {
    expect(() => applyCandidateAction({}, 'setProfile', '/bin/zsh')).toThrow(/unsupported shell action/)
    expect(() => applyCandidateAction({}, undefined, 'nu')).toThrow(/unsupported shell action/)
  })
})
