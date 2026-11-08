import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync, symlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// Intended location: <repository>/scripts/e2e-sidechat-images.mjs.
// Dependencies must be preinstalled; this script never installs packages.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name, fallback) => {
  if (!args.includes(name)) return fallback
  const value = args[args.indexOf(name) + 1]
  assert(value && !value.startsWith('--'), `${name} requires a value`)
  return value
}
const baseline = args.includes('--baseline')
const largeImage = args.includes('--large-image')
const fixtureWidth = largeImage ? 1024 : 64
const fixtureHeight = largeImage ? 768 : 48
const plugin = resolve(option('--plugin', root))
const hostRootOption = option('--host-root')
assert(hostRootOption, '--host-root is required (directory containing node_modules/@deepseek-ai/dsh/lib/bin.js)')
const hostRoot = resolve(hostRootOption)
const tools = join(hostRoot, 'node_modules')
const hostPackage = JSON.parse(readFileSync(join(tools, '@deepseek-ai/dsh/package.json'), 'utf8'))
assert.equal(hostPackage.version, '0.2.2-rc.1', 'preinstalled host must be 0.2.2-rc.1')
const channel = option('--channel')
const require = createRequire(join(root, 'package.json'))
const { chromium, request, expect } = require('@playwright/test')
const sharp = createRequire(join(hostRoot, 'package.json'))('sharp')
const cli = join(tools, '@deepseek-ai/dsh/lib/bin.js')
const artifactsParent = resolve(option('--artifacts-dir', tmpdir()))
mkdirSync(artifactsParent, { recursive: true })
// Preserve evidence after success or failure.
const run = mkdtempSync(join(artifactsParent, baseline ? 'sidechat-baseline-' : 'sidechat-images-'))
const home = join(run, 'home')
const workspace = join(run, 'workspace')
const profile = join(home, 'profiles/web')
const result = { mode: baseline ? 'baseline' : 'images', status: 'running', run, plugin, startedAt: new Date().toISOString(), steps: [], screenshots: [], providerRequests: [], pluginRequests: [], imageReads: [], pageErrors: [], registrationErrors: [] }
let host, browser, api, page, mock
let hostSerial = 0
let hostPort = 0
let interrupted
let finalization
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const redact = text => String(text).replace(/([?&]token=)[^\s&"<>]+/g, '$1[redacted]')
async function until(label, read, timeout = 45000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await delay(200)
  }
  throw new Error(`Timed out waiting for ${label}`)
}
async function stopHost() {
  if (!host) return
  const child = host
  host = undefined
  if (child.exitCode !== null || !child.pid) return
  if (process.platform === 'win32') {
    await new Promise((done, reject) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      killer.once('error', reject)
      killer.once('exit', code => { if (code !== 0) child.kill(); done() })
    })
  } else {
    const killGroup = signal => {
      try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    killGroup('SIGTERM')
    const deadline = Date.now() + 5000
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) await delay(100)
    killGroup('SIGKILL')
  }
  await until('host exit', () => child.exitCode !== null || child.signalCode !== null, 15000)
}
async function boot() {
  if (interrupted !== undefined) throw new Error(`Interrupted by ${interrupted}`)
  const logfile = join(run, `host-${++hostSerial}.log`)
  const fd = openSync(logfile, 'a')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^DSH_|(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET)/i.test(key)))
  Object.assign(env, { DSH_HOME: home, SIDECHAT_IMAGE_TEST_KEY: 'local-deterministic-test-key' })
  host = spawn(process.execPath, [cli, 'web', '--port', String(hostPort), '--no-open'], { cwd: workspace, env, stdio: ['ignore', fd, fd], windowsHide: true, detached: process.platform !== 'win32' })
  closeSync(fd)
  let spawnError
  host.once('error', error => { spawnError = error })
  const launch = await until('authenticated host launch', () => {
    if (spawnError) throw spawnError
    const text = readFileSync(logfile, 'utf8')
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[\w-]+/)
    if (match) return match[0]
    if (host.exitCode !== null) throw new Error(`Host exited ${host.exitCode}; inspect ${logfile}`)
  }, 120000)
  api = await request.newContext()
  const exchange = await api.get(launch, { maxRedirects: 0 })
  assert(exchange.status() >= 300 && exchange.status() < 400, 'launch token exchange redirects')
  const state = await api.storageState()
  assert(state.cookies.length > 0, 'launch token exchanged through Playwright request')
  const origin = new URL(launch).origin
  hostPort = Number(new URL(launch).port)
  result.steps.push({ step: 'host-authenticated', origin, hostPid: host.pid })
  return { origin, state }
}
async function rpc(origin, method, value) {
  const response = await api.post(`${origin}/api/${method}`, { data: { type: 'client-request', rpcId: `audit-${Date.now()}`, method, payload: { args: { request: value } } } })
  assert(response.ok(), `${method} HTTP ${response.status()}`)
  const body = await response.json()
  assert.equal(body.result?.ok, true, JSON.stringify(body))
  return body.result.value
}
async function screenshot(name) {
  const path = join(run, `${name}.png`)
  await page.screenshot({ path, fullPage: true })
  result.screenshots.push(path)
}
async function observePage(context) {
  page = await context.newPage()
  page.on('pageerror', error => result.pageErrors.push(redact(error.message)))
  page.on('console', message => { if (message.type() === 'error' && /native register .* error|\[dsh-better-sidebar\]/.test(message.text())) result.registrationErrors.push(redact(message.text())) })
  page.on('request', req => {
    if (req.url().includes('/sidebar/') && req.method() === 'POST') {
      try {
        const body = req.postDataJSON()
        if (Array.isArray(body.images)) body.images = body.images.map(({ data, ...image }) => ({ ...image, encodedBytes: data.length, sourceBytes: Buffer.from(data, 'base64').length }))
        result.pluginRequests.push({ path: new URL(req.url()).pathname, bodyBytes: Buffer.byteLength(req.postData() ?? ''), body })
      } catch (error) { result.registrationErrors.push(`Request capture failed: ${redact(error.message)}`) }
    }
  })
  page.on('response', response => {
    if (response.url().includes('/sidebar/sidechat-image')) result.imageReads.push({ path: new URL(response.url()).pathname + new URL(response.url()).search, status: response.status(), contentType: response.headers()['content-type'] })
  })
}
async function dismiss() {
  for (let i = 0; i < 5; i++) {
    for (const name of [/^(Continue|继续)$/, /^(Configure later|稍后配置)$/, /^(Close|关闭)$/]) {
      const button = page.getByRole('dialog').getByRole('button', { name }).first()
      if (await button.isVisible().catch(() => false) && await button.isEnabled().catch(() => false)) await button.click({ timeout: 2000 }).catch(() => {})
    }
    await delay(250)
  }
}
const composer = () => page.locator('[class*="sidechatComposer"] textarea:visible').first()
const transcriptImages = () => page.locator('[class*="sidechatScroll"] img:visible')
async function openSidechat() {
  if (await composer().isVisible().catch(() => false)) return
  const expand = page.locator('[data-sidebar-right-expand]:visible').first()
  if (await expand.isVisible()) await expand.click()
  if (await composer().isVisible().catch(() => false)) return
  const entry = page.locator('[data-sidebar-right-guide-entry="sidechat"]').first()
  if (!await entry.isVisible()) await page.locator('[data-dockkit-add-tab]:visible').first().click()
  await expect(page.locator('[data-sidebar-right-guide-entry="terminal"]')).toHaveCount(1)
  await expect(page.locator('[data-sidebar-right-guide-entry="browser"]')).toHaveCount(0)
  await entry.click()
  await expect(composer()).toBeVisible({ timeout: 45000 })
}
async function mountSmoke() {
  async function openFiles() {
    const files = page.locator('[data-sidebar-right-guide-entry="files"]')
    if (!await files.isVisible().catch(() => false)) await page.locator('[data-dockkit-add-tab]:visible').first().click()
    await files.click()
    await expect(page.locator('[data-sidebar-right-panel] [role="button"][title$="hello.txt"]:visible')).toHaveCount(1)
  }
  await openFiles()
  await page.locator('[data-sidebar-right-panel] [role="button"][title$="hello.txt"]:visible').click()
  await expect(page.locator('[data-sidebar-right-panel]')).toContainText('image mount fixture')
  await openFiles()
  await page.evaluate(() => globalThis.document.querySelector('[data-dsh-better-sidebar]')?.setAttribute('data-e2e-generation', 'before-reload'))
  const stamp = new Date()
  utimesSync(join(plugin, 'lib/client.js'), stamp, new Date(stamp.getTime() + 2000))
  await expect(page.locator('[data-dsh-better-sidebar][data-e2e-generation="before-reload"]')).toHaveCount(0, { timeout: 60000 })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 60000 })
  await openFiles()
  await expect(page.locator('[data-sidebar-right-unavailable]')).toHaveCount(0)
  assert.deepEqual(result.registrationErrors, [])
  result.steps.push({ step: 'packed-mount-and-native-entry-replacement', filesReadable: true, registrationErrors: 0 })
  await screenshot('native-entry-replacement')
}
async function assertImages(count, step) {
  await expect(transcriptImages()).toHaveCount(count, { timeout: 45000 })
  await expect.poll(() => transcriptImages().evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0))).toBe(true)
  result.steps.push({ step, count, images: await transcriptImages().evaluateAll(images => images.map(image => ({ alt: image.alt, width: image.naturalWidth, height: image.naturalHeight }))) })
  await screenshot(step)
}
async function sendImage(kind, fixture) {
  const marker = `audit-${kind}-image`
  const before = result.providerRequests.length
  if (kind === 'selected') {
    await page.locator('[class*="sidechatComposer"] input[type="file"]').setInputFiles(fixture)
  } else {
    await page.evaluate(async base64 => {
      const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
      await navigator.clipboard.write([new globalThis.ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })])
    }, readFileSync(fixture).toString('base64'))
    await composer().focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V')
  }
  await expect(page.locator('[class*="sidechatComposer"] img:visible')).toHaveCount(1)
  await composer().fill(marker)
  await screenshot(`${kind}-draft`)
  await composer().press('Enter')
  const capture = await until(`${kind} provider image request`, () => result.providerRequests.slice(before).find(item => item.images.length > 0 && JSON.stringify(item.body.messages).includes(marker)))
  assert.equal(capture.body.model, 'image-test')
  const latestUser = capture.body.messages.findLast(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'text' && block.text === marker))
  assert(latestUser, 'provider request contains the submitted user marker')
  assert(latestUser.content.some(block => block.type === 'image_url'), 'submitted user message carries provider image')
  await expect(page.locator('[class*="sidechatScroll"]')).toContainText('IMAGE_AUDIT_OK', { timeout: 45000 })
  result.steps.push({ step: `${kind}-provider-image`, capture: capture.path, images: capture.images })
}

function finalize() {
  finalization ??= (async () => {
    await browser?.close().catch(() => {})
    await api?.dispose().catch(() => {})
    await stopHost().catch(error => { result.status = 'failed'; result.cleanupError = String(error); process.exitCode = 1 })
    if (mock) { mock.closeAllConnections(); await new Promise(done => mock.close(done)) }
    result.finishedAt = new Date().toISOString()
    result.providerRequests = result.providerRequests.map(({ body: _body, ...capture }) => capture)
    json(join(run, 'result.json'), result)
    for (let n = 1; n <= hostSerial; n++) {
      const path = join(run, `host-${n}.log`)
      writeFileSync(path, redact(readFileSync(path, 'utf8')))
    }
    console.log(redact(JSON.stringify({ status: result.status, result: join(run, 'result.json'), error: result.error }, null, 2)))
  })()
  return finalization
}
function onInterrupt(signal) {
  if (interrupted !== undefined) return
  interrupted = signal
  result.status = 'failed'
  result.interrupted = signal
  const code = signal === 'SIGINT' ? 130 : 143
  void finalize().then(() => process.exit(code), error => {
    console.error(redact(error.stack ?? error))
    process.exit(code)
  })
}
process.on('SIGINT', () => onInterrupt('SIGINT'))
process.on('SIGTERM', () => onInterrupt('SIGTERM'))

try {
  mkdirSync(profile, { recursive: true })
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(join(tools, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'), process.platform === 'win32' ? 'junction' : 'dir')
  symlinkSync(plugin, join(profile, 'node_modules/dsh-better-sidebar'), process.platform === 'win32' ? 'junction' : 'dir')
  json(join(profile, 'package.json'), { name: 'sidechat-image-audit-profile', private: true, dependencies: { 'dsh-better-sidebar': `link:${plugin.replaceAll('\\', '/')}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-better-sidebar'] } } })
  const fixture = join(run, 'fixture.png')
  if (largeImage) {
    const pixels = Buffer.alloc(fixtureWidth * fixtureHeight * 3)
    let seed = 42
    for (let i = 0; i < pixels.length; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i] = seed >>> 24 }
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = (y * fixtureWidth + x) * 3; pixels[i] = 240; pixels[i + 1] = 74; pixels[i + 2] = 34 }
    await sharp(pixels, { raw: { width: fixtureWidth, height: fixtureHeight, channels: 3 } }).png().toFile(fixture)
    assert(readFileSync(fixture).length > 1024 * 1024, 'fixture exercises the image-specific body budget')
  } else await sharp({ create: { width: fixtureWidth, height: fixtureHeight, channels: 3, background: '#f04a22' } }).png().toFile(fixture)
  result.fixture = { path: fixture, sha256: hash(readFileSync(fixture)), bytes: readFileSync(fixture).length, width: fixtureWidth, height: fixtureHeight }
  writeFileSync(join(workspace, 'hello.txt'), 'image mount fixture\n')
  mock = createServer(async (req, res) => {
    try {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ object: 'list', data: [{ id: 'image-test', object: 'model', owned_by: 'audit' }] }))
      }
      assert.equal(req.url, '/v1/chat/completions')
      assert.equal(req.headers.authorization, 'Bearer local-deterministic-test-key')
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = JSON.parse(raw)
      const images = []
      for (const message of body.messages ?? []) for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block.type !== 'image_url') continue
        const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(block.image_url.url)
        assert(match, 'provider image is inline base64')
        const bytes = Buffer.from(match[2], 'base64')
        const metadata = await sharp(bytes).metadata()
        assert.equal(metadata.width, fixtureWidth)
        assert.equal(metadata.height, fixtureHeight)
        const pixel = await sharp(bytes).removeAlpha().raw().toBuffer()
        assert(Math.abs(pixel[0] - 240) < 10 && Math.abs(pixel[1] - 74) < 10 && Math.abs(pixel[2] - 34) < 10, 'provider pixels match fixture')
        images.push({ mime: match[1], bytes: bytes.length, sha256: hash(bytes), width: metadata.width, height: metadata.height })
      }
      const path = join(run, `provider-${result.providerRequests.length + 1}.json`)
      json(path, body)
      result.providerRequests.push({ path, body, images })
      const text = images.length ? 'IMAGE_AUDIT_OK' : 'AUDIT_READY'
      const common = { id: 'chatcmpl-audit', object: 'chat.completion.chunk', created: 1, model: 'image-test' }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } })}\n\n`)
        res.end('data: [DONE]\n\n')
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } }))
      }
    } catch (error) {
      result.mockError = redact(error)
      res.writeHead(500)
      res.end('mock assertion failed')
    }
  })
  await new Promise((done, reject) => { mock.once('error', reject); mock.listen(0, '127.0.0.1', done) })
  const mockPort = mock.address().port
  json(join(profile, 'cordis.patch.yml'), [
    { id: 'llm-pi-ai', config: { providers: { 'image-mock': { api: 'openai-completions', baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKeyEnv: 'SIDECHAT_IMAGE_TEST_KEY', models: [{ id: 'image-test', input: ['text', 'image'], contextWindow: 262144, maxTokens: 4096 }], retryPolicy: { mode: 'normal', maxRetries: 0 } } } } },
    { id: 'agent-default-model', config: { provider: 'image-mock', model: 'image-test' } }
  ])
  let connection = await boot()
  const created = await rpc(connection.origin, 'workspace/create', { path: workspace })
  const session = await rpc(connection.origin, 'session/create', { workspaceId: created.workspace.workspaceId })
  result.sessionId = session.sessionId
  browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: true })
  let context = await browser.newContext({ storageState: connection.state, viewport: { width: 1440, height: 1000 }, locale: 'en-US', permissions: ['clipboard-read', 'clipboard-write'] })
  await observePage(context)
  await page.goto(connection.origin, { waitUntil: 'domcontentloaded' })
  await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 60000 })
  await dismiss()
  const hostComposer = page.getByRole('textbox', { name: /^(Describe what you want to build|描述你想要构建)/ })
  await hostComposer.click({ timeout: 45000 })
  await page.keyboard.type('image audit parent seed')
  await page.getByRole('button', { name: /^(Send message|发送消息)$/ }).click()
  await until('parent model response', () => result.providerRequests.length > 0)
  await page.locator('[data-sidebar-right-expand]:visible').first().waitFor({ timeout: 45000 })
  await openSidechat()
  await screenshot('baseline-sidechat')
  result.steps.push({ step: 'baseline-rendered', imageInputs: await page.locator('[class*="sidechatComposer"] input[type="file"]').count() })
  if (!baseline) {
    await sendImage('selected', fixture)
    await assertImages(1, 'selected-saved')
    await sendImage('pasted', fixture)
    await assertImages(2, 'pasted-saved')
    const threadCall = result.pluginRequests.findLast(item => item.body?.childId)
    assert(threadCall, 'observed child thread through real plugin requests')
    result.childId = threadCall.body.childId
    await page.reload({ waitUntil: 'domcontentloaded' })
    await openSidechat()
    await assertImages(2, 'page-reload')
    const coldUrl = page.url()
    const coldState = await context.storageState()
    await context.close()
    await api.dispose()
    api = undefined
    await stopHost()
    connection = await boot()
    context = await browser.newContext({ storageState: { ...coldState, cookies: connection.state.cookies }, viewport: { width: 1440, height: 1000 }, locale: 'en-US' })
    await observePage(context)
    await page.goto(coldUrl, { waitUntil: 'domcontentloaded' })
    await expect(page.locator('[data-dsh-better-sidebar]')).toBeAttached({ timeout: 60000 })
    await dismiss()
    await openSidechat()
    await assertImages(2, 'cold-host-restart')
    assert(result.imageReads.filter(item => item.status === 200).length >= 6, 'saved image reads succeed across reload and cold host')
    assert(!result.mockError, result.mockError)
    if (largeImage) assert(result.pluginRequests.filter(item => item.path.endsWith('/sidechat.prompt')).every(item => item.bodyBytes > 1024 * 1024), 'selected and pasted image prompts exceed the ordinary JSON body cap')
    if (args.includes('--mount-check')) await mountSmoke()
  }
  assert.deepEqual(result.pageErrors, [])
  result.status = baseline ? 'baseline-recorded' : 'passed'
} catch (error) {
  result.status = 'failed'
  result.error = redact(error.stack ?? error)
  if (page) await screenshot('failure').catch(() => {})
  process.exitCode = 1
} finally {
  await finalize()
}
