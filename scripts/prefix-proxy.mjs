#!/usr/bin/env node
/**
 * HTTP + WebSocket reverse proxy that mounts an upstream origin under a
 * path prefix (code-server /proxy/<port>/ style). Rewrites Location so the
 * browser stays under the prefix after DSH's token→cookie 303. Auth cookies
 * keep Path=/ so origin-root `/api` calls on the same proxy origin still
 * authenticate.
 *
 * Env:
 *   UPSTREAM       e.g. http://127.0.0.1:4199
 *   PROXY_PREFIX   e.g. /dataops/proxy/3080
 *   PROXY_PORT     listen port (default 0 = OS assigned; print listen URL)
 */
import http from 'node:http'
import { request as httpRequest } from 'node:http'

const UPSTREAM = process.env.UPSTREAM
const PREFIX = (process.env.PROXY_PREFIX ?? '/dataops/proxy/3080').replace(/\/$/, '')
const LISTEN = Number(process.env.PROXY_PORT ?? 0)
if (!UPSTREAM) {
  console.error('prefix-proxy: UPSTREAM is required')
  process.exit(1)
}
const upstream = new URL(UPSTREAM)

function defaultPort(protocol) {
  return protocol === 'https:' ? '443' : '80'
}

function isUpstreamHost(url) {
  const port = url.port || defaultPort(url.protocol)
  const expected = upstream.port || defaultPort(upstream.protocol)
  return url.hostname === upstream.hostname && port === expected
}

function stripPrefix(rawUrl) {
  const url = new URL(rawUrl ?? '/', 'http://proxy.internal')
  if (url.pathname === PREFIX || url.pathname === `${PREFIX}/`) {
    url.pathname = '/'
  } else if (url.pathname.startsWith(`${PREFIX}/`)) {
    url.pathname = url.pathname.slice(PREFIX.length)
  }
  return `${url.pathname}${url.search}`
}

function prefixPath(pathname) {
  if (pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)) return pathname
  return `${PREFIX}${pathname.startsWith('/') ? pathname : `/${pathname}`}`
}

function rewriteLocation(value) {
  if (value === undefined || value === '') return value
  try {
    const absolute = /^[a-z][a-z0-9+.-]*:/i.test(value)
    const url = new URL(value, upstream.origin)
    if (absolute && !isUpstreamHost(url)) return value
    return `${prefixPath(url.pathname)}${url.search}${url.hash}`
  } catch {
    return value
  }
}

function copyHeaders(headers) {
  const out = { ...headers }
  out.host = upstream.host
  return out
}

const server = http.createServer((req, res) => {
  const path = stripPrefix(req.url)
  const proxyReq = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    path,
    method: req.method,
    headers: copyHeaders(req.headers),
  }, (proxyRes) => {
    const headers = { ...proxyRes.headers }
    if (typeof headers.location === 'string') headers.location = rewriteLocation(headers.location)
    res.writeHead(proxyRes.statusCode ?? 502, headers)
    proxyRes.pipe(res)
  })
  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('upstream error')
  })
  req.pipe(proxyReq)
})

server.on('upgrade', (req, socket, head) => {
  const path = stripPrefix(req.url)
  const proxyReq = httpRequest({
    hostname: upstream.hostname,
    port: upstream.port,
    path,
    method: 'GET',
    headers: copyHeaders(req.headers),
  })
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}`]
    for (const [name, value] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) lines.push(`${name}: ${item}`)
      } else if (value !== undefined) {
        lines.push(`${name}: ${value}`)
      }
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (proxyHead.length > 0) socket.write(proxyHead)
    proxySocket.pipe(socket)
    socket.pipe(proxySocket)
  })
  proxyReq.on('response', (proxyRes) => {
    socket.write(`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`)
    for (const [name, value] of Object.entries(proxyRes.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) socket.write(`${name}: ${item}\r\n`)
      } else if (value !== undefined) {
        socket.write(`${name}: ${value}\r\n`)
      }
    }
    socket.write('\r\n')
    proxyRes.pipe(socket)
  })
  proxyReq.on('error', () => socket.destroy())
  socket.on('error', () => proxyReq.destroy())
  proxyReq.end(head)
})

server.listen(LISTEN, '127.0.0.1', () => {
  const addr = server.address()
  const port = typeof addr === 'object' && addr !== null ? addr.port : LISTEN
  console.log(`prefix-proxy: http://127.0.0.1:${port}${PREFIX}/`)
})
