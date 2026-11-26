#!/usr/bin/env node
/** No provider credentials, caller paths, write bodies or arbitrary methods. */
import { pathToFileURL, URL } from 'node:url'
import { request } from 'node:http'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import console from 'node:console'

export function commitTarget(urlText, draftId) {
  if (typeof draftId !== 'string' || !/^[a-f0-9]{48}$/u.test(draftId)) throw new Error('Invalid draft ID')
  const url = new URL(urlText)
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/u.test(url.hostname)
  if (url.protocol !== 'http:' || !loopback || url.port === '' || url.username !== '' || url.password !== '' || url.pathname !== '/sidebar/agent/clues/commit' || url.search !== '' || url.hash !== '') throw new Error('Invalid local draft commit URL')
  return { url: url.href, body: JSON.stringify({ draftId }) }
}
export async function commitDraft(urlText, draftId) {
  const target = commitTarget(urlText, draftId)
  // Node fetch adds Sec-Fetch-Mode. The fixed route deliberately rejects browser
  // signals, so use an ordinary native HTTP request without fetch metadata.
  const response = await new Promise((resolve, reject) => {
    const req = request(target.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(target.body) } }, res => {
      const chunks = []
      let bytes = 0
      res.on('data', chunk => {
        bytes += chunk.length
        if (bytes > 64 * 1024) { res.destroy(); reject(new Error('The commit response exceeded its capacity; inspect the retained draft')); return }
        chunks.push(chunk)
      })
      res.on('error', () => reject(new Error('The commit response was interrupted; inspect the retained draft')))
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.setTimeout(60_000, () => req.destroy(new Error('The commit timed out; inspect the resource and retained draft')))
    req.on('error', () => reject(new Error('The commit outcome is uncertain; inspect the resource and retained draft')))
    req.end(target.body)
  })
  let result
  try { result = JSON.parse(response.text) } catch { throw new Error('The commit outcome could not be read; inspect the retained draft') }
  if (response.status < 200 || response.status >= 300 || result.ok !== true || result.value?.status !== 'committed') throw new Error('The commit did not confirm success; inspect the resource and retained draft before doing anything else')
  return result
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: commit-draft.mjs <local-commit-url> <draftId>')
    console.log(JSON.stringify(await commitDraft(process.argv[2], process.argv[3])))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'The commit outcome is uncertain; inspect the retained draft')
    process.exitCode = 1
  }
}
