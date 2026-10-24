/**
 * Explorer row ordering: the client-side sort behind the tree header's sort
 * control.
 *
 * The host already returns every level directory-first, case-insensitively by
 * name (`fs-tree.ts`'s `compareEntries`), and {@link DEFAULT_FILE_TREE_SORT}
 * reproduces exactly that order — so the control's out-of-the-box state is
 * indistinguishable from having no control at all. "Type" groups by extension
 * (the part after the last dot, lowercased), the way VS Code's "Sort by Type"
 * does; a directory has no extension, so with "folders first" off it lands
 * with the extension-less files and both fall back to the name order.
 *
 * Sorting runs on a COPY: the level cache is shared per absolute path (two
 * sessions reading one directory share an entry), so a cached listing must
 * never be reordered in place.
 */

/** The two orderings the control offers ("by modified time" is a separate issue). */
export type FileTreeSortKey = 'name' | 'type'

/** One explorer sort choice: the key plus the folders-first switch. */
export interface FileTreeSort {
  key: FileTreeSortKey
  /** Directories before files, whatever the key says. */
  dirsFirst: boolean
}

/** The default choice — byte-for-byte the order the host listing arrives in. */
export const DEFAULT_FILE_TREE_SORT: FileTreeSort = { key: 'name', dirsFirst: true }

/**
 * The extension shown as a row's "type": the text after the LAST dot,
 * lowercased, `''` for a directory or a dot-less name (a leading dot is a
 * hidden file's marker, not an extension, so `.gitignore` has none).
 */
export function typeOf(name: string, isDir: boolean): string {
  if (isDir) return ''
  const at = name.lastIndexOf('.')
  return at <= 0 ? '' : name.slice(at + 1).toLowerCase()
}

/**
 * Case-insensitive name order with the host's deterministic tie-break: names
 * that only differ in case keep their original code-point order (`A` before
 * `a`), so the order is total and stable.
 */
function compareName(a: { name: string }, b: { name: string }): number {
  const la = a.name.toLowerCase()
  const lb = b.name.toLowerCase()
  if (la !== lb) return la < lb ? -1 : 1
  if (a.name === b.name) return 0
  return a.name < b.name ? -1 : 1
}

/**
 * Order one level's rows for display. The input is never mutated (the level
 * cache is shared), and with {@link DEFAULT_FILE_TREE_SORT} the result equals
 * `fs-tree.ts`'s server order for every input.
 *
 * @param entries - the level's rows, in host order.
 * @param sort - the caller's choice (key + folders-first switch).
 * @returns a new array; the rows themselves are the same objects.
 */
export function sortEntries<T extends { name: string; isDir: boolean }>(
  entries: readonly T[],
  sort: FileTreeSort,
): T[] {
  return [...entries].sort((a, b) => {
    if (sort.dirsFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1
    if (sort.key === 'type') {
      const ta = typeOf(a.name, a.isDir)
      const tb = typeOf(b.name, b.isDir)
      if (ta !== tb) return ta < tb ? -1 : 1
    }
    return compareName(a, b)
  })
}
