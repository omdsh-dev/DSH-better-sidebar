import type { MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import type { JsonValue } from '../../../../clues/types.ts'

/** Only a provider-supplied repo and immutable ref may resolve GitHub-relative media. */
export function githubPathImages(data: JsonValue): MarkdownPathImages | undefined {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return undefined
  const { imageRepository: repo, imageRef: ref } = data as Record<string, JsonValue>
  if (typeof repo !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(repo)
    || typeof ref !== 'string' || !/^[a-f0-9]{40}$/i.test(ref)) return undefined
  const base = new URL('https://raw.githubusercontent.com/' + repo + '/' + ref + '/')
  return { resolve(destination) {
    if (!destination || /^[\s\\#]|^[a-z][a-z\d+.-]*:|^\/\//i.test(destination)) return undefined
    const url = new URL(destination.replace(/^\//, ''), base)
    return url.origin === base.origin && url.pathname.startsWith(base.pathname) ? url.href : undefined
  } }
}
