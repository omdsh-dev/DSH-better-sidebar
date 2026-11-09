/** The maximum number of candidate paths checked after a Markdown path failure. */
const MAX_INSERTIONS = 8

/**
 * Check whether a path uses a Windows drive or UNC absolute-path form.
 *
 * @param path - Path received from the host Markdown renderer
 * @returns Whether the path is absolute in Windows syntax
 */
export function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/u.test(path)
    || /^(?:\\\\[^\\/]+[\\/][^\\/]+|\/\/[^/]+\/[^/]+)/u.test(path)
}

/**
 * Build Windows path candidates by restoring separators before Markdown punctuation.
 *
 * @param path - The decoded path received from the host Markdown renderer.
 * @returns Candidate paths, or an empty list when the path is not Windows-absolute
 *   or contains more than eight punctuation positions.
 */
export function markdownPathRepairCandidates(path: string): string[] {
  if (!isWindowsAbsolutePath(path)) return []

  const isDrivePath = /^[A-Za-z]:[\\/]/u.test(path)
  const positions: number[] = []
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index)
    const punctuation = (code >= 33 && code <= 47)
      || (code >= 58 && code <= 64)
      || (code >= 91 && code <= 96)
      || (code >= 123 && code <= 126)
    if (!punctuation || path[index] === '/' || path[index] === '\\' || (isDrivePath && index === 1)) continue
    positions.push(index)
    if (positions.length > MAX_INSERTIONS) return []
  }

  if (positions.length === 0) return []
  const candidates: string[] = []
  for (let mask = 1; mask < 2 ** positions.length; mask += 1) {
    let candidate = ''
    let positionIndex = 0
    for (let index = 0; index < path.length; index += 1) {
      if (positions[positionIndex] === index) {
        if ((mask & (1 << positionIndex)) !== 0) candidate += '\\'
        positionIndex += 1
      }
      candidate += path[index]
    }
    candidates.push(candidate)
  }
  return candidates
}
