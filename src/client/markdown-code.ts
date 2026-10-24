/**
 * The ONE code-region mask the two markdown source rewriters share
 * (`markdown-images.ts` for image destinations, `markdown-navigation.ts` for
 * link destinations).
 *
 * Both rewrites are regex passes over raw markdown, so anything that LOOKS like
 * a link or an image inside a code region must be left verbatim: a README that
 * documents `[x](./a.md#标题)` or `![i](./p.png)` means to show that syntax, not
 * to have it rewritten. Masking preserves the region byte for byte — the
 * sentinel is a NUL, which cannot appear in markdown source, and the original
 * text goes back in after the pass.
 *
 * What counts as a code region is CommonMark's own rule: an INLINE code span
 * (a backtick run closed by a run of the same length), and a FENCED block — an
 * opening fence of three or more backticks OR three or more tildes, closed by a
 * fence of the same character at least as long as the opener. The fence line
 * itself is masked too (its leading run is what a backtick-span scan would
 * otherwise mistake for a code span), and an unclosed fence runs to the end of
 * the text, exactly as a renderer treats it.
 *
 * Both fence characters matter: `~~~` is a legal fence in CommonMark and in
 * every renderer this plugin draws through, so an image or a link demonstrated
 * inside one is as much an example as one inside ``` ``` ```.
 */

/** A backtick or tilde fence: three or more, at up to three spaces of indent. */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/gm
/** An inline code span: a backtick run, then the next run of the SAME length. */
const CODE_SPAN_RE = /(`+)[\s\S]*?\1/g

/** A masked region's placeholder: NUL + index + NUL. */
// eslint-disable-next-line no-control-regex -- NUL is the deliberate mask sentinel (cannot appear in source markdown)
const MASK_RE = /\u0000(\d+)\u0000/g

/** A half-open `[start, end)` range of the source. */
type Region = [number, number]

/**
 * The length of the fence run at the start of `line` — its leading `\`` or `~`
 * characters. Zero when the line is not a fence (or not one of ours).
 */
function fenceRun(line: string): { marker: string; length: number } | null {
  const marker = line.charAt(0)
  if (marker !== '`' && marker !== '~') return null
  let length = 0
  while (line.charAt(length) === marker) length += 1
  return length >= 3 ? { marker, length } : null
}

/** Whether a line closes a fence opened by `marker` × `length` (CommonMark).
 *  The tail may carry a CRLF terminator: `\r` is the line's ending, not
 *  content, and reading it as content left every fence in a CRLF document
 *  unclosed — the masked region then ran to the end of the file and the link /
 *  image passes skipped everything after the first fence. */
function closesFence(line: string, marker: string, length: number): boolean {
  if (line.charAt(0) !== marker) return false
  let run = 0
  while (line.charAt(run) === marker) run += 1
  return run >= length && /^[ \t\r]*$/.test(line.slice(run))
}

/**
 * Every fenced block in `text`, as half-open ranges that INCLUDE the fence
 * lines.
 *
 * The scan is a single forward walk that cannot be fooled by a fence-looking
 * line inside a block or before the opener: a closing fence has to be the same
 * character at least as long as its opener, and a fence nested inside a longer
 * one is content, not a delimiter. An unclosed fence runs to the end of the
 * text — the extent a renderer gives it.
 */
function fenceRegions(text: string): Region[] {
  const regions: Region[] = []
  let searchFrom = 0
  for (;;) {
    FENCE_RE.lastIndex = searchFrom
    const opener = FENCE_RE.exec(text)
    if (opener === null) break
    const start = opener.index
    const run = fenceRun(opener.at(1) ?? '')
    const bodyStart = start + opener[0].length
    let end = text.length
    if (run !== null) {
      // Walk the body line by line until a closing fence (or the end of text).
      let at = bodyStart
      while (at < text.length) {
        if (text.charAt(at) === '\n') { at += 1; continue }
        const lineEnd = text.indexOf('\n', at)
        const stop = lineEnd === -1 ? text.length : lineEnd
        if (closesFence(text.slice(at, stop), run.marker, run.length)) {
          end = stop
          break
        }
        at = stop + 1
      }
    }
    regions.push([start, end])
    searchFrom = end
  }
  return regions
}

/** The masked text, plus the way back to the original. */
export interface MaskedCodeRegions {
  /** `text` with every code region replaced by a placeholder. */
  masked: string
  /** Put every masked region back, in place. */
  restore: (text: string) => string
}

/**
 * Mask the fenced blocks and inline code spans of one markdown text.
 * @param text - the markdown source.
 * @returns the masked text and its restore function.
 */
export function maskCodeRegions(text: string): MaskedCodeRegions {
  const masks: string[] = []
  const mask = (region: string): string => {
    masks.push(region)
    return `\u0000${masks.length - 1}\u0000`
  }

  // Fences first (they are the outer region), and from the END backwards so
  // each splice leaves the offsets of the not-yet-masked regions valid.
  let fenced = text
  for (const [start, end] of fenceRegions(text).reverse()) {
    fenced = fenced.slice(0, start) + mask(text.slice(start, end)) + fenced.slice(end)
  }
  // Then the inline spans the fence pass did not swallow.
  const masked = fenced.replace(CODE_SPAN_RE, (span: string) => mask(span))

  return {
    masked,
    restore: (value: string): string => value.replace(MASK_RE, (_m, index: string) => masks[Number(index)] ?? ''),
  }
}
