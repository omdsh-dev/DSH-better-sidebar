/** Display-only labels for discovered checkout roots. No filesystem or browser-platform access. */
export interface RepositoryLabel {
  readonly root: string
  readonly label: string
}

type PathKind = 'posix' | 'drive' | 'unc' | 'relative'
interface ParsedPath {
  kind: PathKind
  anchor: string
  parts: string[]
  separator: '/' | '\\'
  name: string
  absolute: string
  hasParentSegment: boolean
}

/** Interpret each path in its own host dialect, never in the browser's dialect. */
function parsePath(raw: string, preferPosixDoubleSlash = false): ParsedPath {
  // Windows may hand out namespaced drive or UNC paths. Remove only the
  // namespace for comparison/display; the original root remains untouched.
  const spelling = preferPosixDoubleSlash && raw.startsWith('/') ? raw
    : /^[\\/]{2}\?[\\/]UNC[\\/]/i.test(raw)
      ? raw.replace(/^[\\/]{2}\?[\\/]UNC[\\/]/i, '\\\\')
      : raw.replace(/^[\\/]{2}\?[\\/](?=[a-zA-Z]:[\\/])/, '')
  let kind: PathKind = 'relative'
  let anchor = ''
  let rest = spelling
  let separator: '/' | '\\' = '/'
  const drive = /^([a-zA-Z]:)[\\/]+/.exec(spelling)
  const unc = /^[\\/]{2}([^\\/]+)[\\/]+([^\\/]+)(?:[\\/]+|$)/.exec(spelling)
  if (drive) {
    kind = 'drive'
    anchor = drive[1]!
    rest = spelling.slice(drive[0].length)
    separator = '\\'
  } else if (unc && !(preferPosixDoubleSlash && spelling.startsWith('/'))) {
    kind = 'unc'
    anchor = `\\\\${unc[1]!}\\${unc[2]!}`
    rest = spelling.slice(unc[0].length)
    separator = '\\'
  } else if (spelling.startsWith('/')) {
    kind = 'posix'
    anchor = '/'
    rest = spelling.replace(/^\/+/, '')
  }
  const split = kind === 'posix' || kind === 'relative' ? /\/+/ : /[\\/]+/
  const parts: string[] = []
  for (const part of rest.split(split)) {
    if (part && part !== '.') parts.push(part)
  }
  // Resolving '..' lexically can be wrong across a symlink. With no filesystem
  // access, preserve it for display and decline to infer containment.
  const hasParentSegment = parts.includes('..')
  const name = parts[parts.length - 1]
    ?? (kind === 'posix' ? '/' : kind === 'drive' ? `${anchor}\\` : kind === 'unc' ? anchor.split('\\').at(-1)! : raw)
  const suffix = parts.join(separator)
  const absolute = kind === 'posix' ? `/${suffix}`
    : kind === 'drive' ? `${anchor}\\${suffix}`
      : kind === 'unc' ? `${anchor}${suffix ? `\\${suffix}` : ''}`
        : suffix || raw
  return { kind, anchor, parts, separator, name, absolute, hasParentSegment }
}

/** Check full path components and drive/share identity; POSIX paths stay case-sensitive. */
function relativeParts(path: ParsedPath, base: ParsedPath | undefined): string[] | undefined {
  if (!base || base.kind === 'relative' || path.kind !== base.kind || base.hasParentSegment || path.hasParentSegment) return undefined
  const windows = path.kind === 'drive' || path.kind === 'unc'
  const same = (left: string, right: string) => windows ? left.toLowerCase() === right.toLowerCase() : left === right
  if (!same(path.anchor, base.anchor) || path.parts.length < base.parts.length) return undefined
  if (!base.parts.every((part, i) => same(part, path.parts[i]!))) return undefined
  return path.parts.slice(base.parts.length)
}

interface LabelCandidate {
  root: string
  parsed: ParsedPath
  parents: string[]
  context: string | undefined
  nextDepth: number
  phase: 0 | 1 | 2
  label: string
}

/** Build a longer label only when a collision actually needs it. */
function advanceLabel(candidate: LabelCandidate): boolean {
  const { parsed, parents } = candidate
  if (candidate.nextDepth <= parents.length) {
    const part = parents[parents.length - candidate.nextDepth]!
    candidate.context = candidate.context === undefined ? part : `${part}${parsed.separator}${candidate.context}`
    candidate.nextDepth += 1
    candidate.label = `${parsed.name} (${candidate.context})`
    return true
  }
  if (candidate.phase === 0) {
    candidate.phase = 1
    candidate.label = `${parsed.name} (${parsed.absolute})`
    return true
  }
  if (candidate.phase === 1) {
    candidate.phase = 2
    candidate.label = candidate.root
    return true
  }
  return false
}

/**
 * Build labels once for the complete list. Short names cover the base, its
 * direct children and an unknown base; deeper paths expose their full relative
 * parent. Roots outside a known base show short parent context. Collisions
 * expand context up to absolute/raw paths, never numbers. Exact duplicate roots
 * share a label and keep their original rows.
 */
export function buildRepositoryLabels(
  roots: readonly string[],
  displayCwd: string | undefined,
  hostHome?: string,
): readonly RepositoryLabel[] {
  // The host's existing home is only a dialect hint; it is never appended to a label.
  // A forward-slash UNC home is itself ambiguous, so do not claim a dialect.
  const homePosix = hostHome !== undefined && hostHome.startsWith('/') && !hostHome.startsWith('//') && !hostHome.startsWith('/\\')
  const homeWindows = hostHome !== undefined && (/^[a-zA-Z]:[\\/]/.test(hostHome) || /^\\[\\/]/.test(hostHome))
  // Without a host hint, a // base is ambiguous. Preserve its spelling and
  // use case-sensitive comparison rather than silently asserting UNC semantics.
  const ambiguousBase = !homePosix && !homeWindows
    && (displayCwd?.startsWith('//') === true || displayCwd?.startsWith('/\\') === true)
  const base = displayCwd === undefined ? undefined : parsePath(displayCwd, homePosix || ambiguousBase)
  const preferPosix = homePosix || (!homeWindows && (base === undefined || base.kind === 'relative' || base.kind === 'posix'))
  const distinct = new Map<string, LabelCandidate>()
  for (const root of roots) {
    if (distinct.has(root)) continue
    const parsed = parsePath(root, preferPosix)
    const relative = relativeParts(parsed, base)
    const relativeParent = relative && relative.length > 1 ? relative.slice(0, -1) : []
    const parents = parsed.parts.slice(0, -1)
    const outsideKnownBase = base !== undefined && base.kind !== 'relative' && !base.hasParentSegment
      && parsed.kind !== 'relative' && !parsed.hasParentSegment && relative === undefined
    const shortParent = !outsideKnownBase ? undefined : parents.at(-1)
      ?? (parsed.kind === 'unc' && parsed.parts.length === 0
        ? `\\\\${parsed.anchor.split('\\')[2]}`
        : parsed.parts.length === 0 ? undefined : parsed.kind === 'posix' ? '/' : `${parsed.anchor}\\`)
    const context = relativeParent.length > 0 ? relativeParent.join(parsed.separator) : shortParent
    const label = context === undefined ? parsed.name : `${parsed.name} (${context})`
    const usedDepth = relativeParent.length || (shortParent !== undefined && parents.length > 0 ? 1 : 0)
    distinct.set(root, { root, parsed, parents, context, nextDepth: Math.max(1, usedDepth + 1), phase: 0, label })
  }

  // Resolve collisions globally, including a literal directory named like a
  // generated label. Every candidate ends in its distinct raw root, so the
  // process terminates without a synthetic numeric identifier.
  for (;;) {
    const byLabel = new Map<string, LabelCandidate[]>()
    for (const candidate of distinct.values()) {
      const group = byLabel.get(candidate.label)
      if (group) group.push(candidate)
      else byLabel.set(candidate.label, [candidate])
    }
    const collisions = [...byLabel.values()].filter(group => group.length > 1)
    if (collisions.length === 0) break
    for (const group of collisions) {
      let advanced = false
      for (const candidate of group) advanced = advanceLabel(candidate) || advanced
      if (!advanced) throw new Error('repository labels could not be disambiguated')
    }
  }
  return roots.map(root => ({ root, label: distinct.get(root)!.label }))
}
