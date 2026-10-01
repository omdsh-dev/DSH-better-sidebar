/**
 * The two pure halves of the frame route: which addresses may be fetched, and how a document is
 * adjusted so it renders correctly when served from another origin.
 *
 * WHY THE ROUTE EXISTS. Joomla sends `X-Frame-Options: SAMEORIGIN` by default and WordPress does
 * the same, so the browser tab shows "refused to connect" for a perfectly healthy site. Measured
 * 2026-08-31 against a freshly provisioned site: `curl` answered 200, the frame answered an error
 * page. The header is set by the server and enforced by the browser; nothing inside the page can
 * opt out of it. Only a third party that fetches the document and serves it again can embed it.
 *
 * ## Two design decisions, both pinned here
 *
 * 1. **Only the HTML document is proxied. Every asset goes direct.** The injected `<base href>`
 *    is what does that: `/media/x.css` then resolves against the site itself rather than the host
 *    serving this copy. It is also correct rather than merely cheap — `X-Frame-Options` applies
 *    to embedded documents, never to images or stylesheets.
 *
 * 2. **Internal addresses are never fetched.** A route that takes an arbitrary url and fetches it
 *    is an SSRF door: it runs on the host, so it reaches what the browser cannot — cloud metadata
 *    at 169.254.169.254, private 10.x networks, the machine's own loopback.
 */
import { describe, it, expect } from 'vitest'

import { frameUrlRefusal, frameableHtml, frameRequestHeaders, hostOriginFor } from '../src/frame-proxy.ts'
import { embeddabilityOf } from '../src/client/browser.ts'

describe('frameUrlRefusal', () => {
  it('accepts public http and https', () => {
    expect(frameUrlRefusal('https://example.com/')).toBeNull()
    expect(frameUrlRefusal('http://example.com/a/b?c=1')).toBeNull()
  })

  it('refuses non-http schemes', () => {
    // `file:` reads the host's disk; `data:` lets the caller author the body and borrow this
    // origin for it.
    expect(frameUrlRefusal('file:///etc/passwd')).toBe('scheme')
    expect(frameUrlRefusal('data:text/html,<b>x</b>')).toBe('scheme')
    expect(frameUrlRefusal('javascript:alert(1)')).toBe('scheme')
  })

  it('refuses anything that is not a URL', () => {
    expect(frameUrlRefusal('')).toBe('shape')
    expect(frameUrlRefusal('not a url')).toBe('shape')
  })

  it('refuses loopback', () => {
    expect(frameUrlRefusal('http://127.0.0.1:51730/')).toBe('local')
    expect(frameUrlRefusal('http://localhost:8080/')).toBe('local')
    expect(frameUrlRefusal('http://[::1]/')).toBe('local')
  })

  it('refuses private networks and cloud metadata', () => {
    // This is the part an SSRF door reaches and a browser does not.
    expect(frameUrlRefusal('http://10.0.0.5/')).toBe('local')
    expect(frameUrlRefusal('http://192.168.1.1/')).toBe('local')
    expect(frameUrlRefusal('http://172.16.5.4/')).toBe('local')
    expect(frameUrlRefusal('http://172.31.255.255/')).toBe('local')
    expect(frameUrlRefusal('http://169.254.169.254/latest/meta-data/')).toBe('local')
  })

  it('172.32 is NOT private — the range stops at 172.31', () => {
    // The boundary that gets written as `^172\.` or as 172.16–172.32 by mistake.
    expect(frameUrlRefusal('http://172.32.0.1/')).toBeNull()
    expect(frameUrlRefusal('http://172.15.0.1/')).toBeNull()
  })
})

describe('frameableHtml', () => {
  const base = 'https://site.example/shop/'

  it('injects <base> right after <head> so relative assets go straight to the site', () => {
    const out = frameableHtml('<html><head><title>x</title></head><body>y</body></html>', base)
    expect(out).toContain(`<base href="${base}">`)
    expect(out.indexOf('<base')).toBeLessThan(out.indexOf('<title>'))
  })

  it('does NOT inject when the page declares its own <base>', () => {
    // The page knows better than we do, and the first `<base>` wins — injecting one would
    // silently change how every link on the page resolves.
    const html = '<html><head><base href="https://other.example/"><title>x</title></head></html>'
    expect(frameableHtml(html, base)).toBe(html)
  })

  it('survives markup with no <head>', () => {
    const out = frameableHtml('<html><body>body only</body></html>', base)
    expect(out).toContain(`<base href="${base}">`)
    expect(out).toContain('body only')
  })

  it('survives a bare fragment', () => {
    const out = frameableHtml('<p>no html element</p>', base)
    expect(out).toContain(`<base href="${base}">`)
    expect(out).toContain('<p>no html element</p>')
  })

  it('matches <head> in any case and with attributes', () => {
    expect(frameableHtml('<HEAD lang="en">', base)).toContain('<base href=')
    expect(frameableHtml('<head\n  data-x="1">', base)).toContain('<base href=')
  })

  it('keeps in-page navigation inside the route', () => {
    // The `<base>` that makes assets work also makes every LINK point straight at the site —
    // where X-Frame-Options refuses the frame again. Measured 2026-08-31: the site rendered,
    // then clicking one article gave "refused to connect". So the document carries a small
    // script that sends same-site navigation back through the route.
    const out = frameableHtml('<html><head></head><body><a href="/posts/x">x</a></body></html>', base, 'http://127.0.0.1:51740')
    expect(out).toContain('/sidebar/frame?url=')
    expect(out).toContain('http://127.0.0.1:51740')
  })

  it('names the route with the forwarded authority and the mount prefix', () => {
    // Behind Tracy's Worker the lane sees `Host: 127.0.0.1:51700` and a mount prefix: the script
    // must send navigation to `https://cowork.example/site.example/sidebar/frame`, not to the
    // loopback authority and not to the host's bare root.
    expect(hostOriginFor({ host: '127.0.0.1:51740' })).toBe('http://127.0.0.1:51740')
    expect(hostOriginFor({ host: '127.0.0.1:51740', 'x-forwarded-host': 'cowork.example', 'x-forwarded-proto': 'https' }, '/site.example'))
      .toBe('https://cowork.example/site.example')
    expect(hostOriginFor({ host: '127.0.0.1:51740' }, '/site.example')).toBe('http://127.0.0.1:51740/site.example')
    expect(hostOriginFor({ 'x-forwarded-host': ['a.example, b.example'] })).toBe('http://a.example')
    expect(hostOriginFor({})).toBeUndefined()
    const out = frameableHtml('<html><head></head><body><a href="/posts/x">x</a></body></html>', base, hostOriginFor({ host: 'h' }, '/site.example'))
    expect(out).toContain('"http://h/site.example"')
  })

  it('adds no script when the caller does not say where the route lives', () => {
    // Without a host origin the script could only build a relative URL, and a relative URL
    // resolves against the `<base>` — straight back to the site it was meant to avoid.
    const out = frameableHtml('<html><head></head><body></body></html>', base)
    expect(out).not.toContain('/sidebar/frame?url=')
  })

  it('escapes quotes in the address so the tag cannot break out', () => {
    // A `"` in the address would close the attribute early and turn the rest into further
    // attributes — which is how a link becomes an event handler.
    const out = frameableHtml('<head>', 'https://site.example/a"onload="alert(1)')
    expect(out).not.toContain('onload="alert(1)"')
    expect(out).toContain('&quot;')
  })
})

/**
 * The verdict that decides whether the tab frames a site directly or routes it through the host.
 *
 * WHY THIS CHANGED. A site may now NAME the origins allowed to frame it — Tracy's own sites do,
 * so the sidebar can show them without the host round trip. The original verdict could not see
 * that: it accepted `frame-ancestors` only when the list contained `*`, so a list naming exactly
 * this origin still read as "blocked". And it let `X-Frame-Options` decide first, which inverts
 * the spec — CSP Level 2 §7.2 says a `frame-ancestors` directive REPLACES `X-Frame-Options`, and
 * browsers implement it that way. Both together meant an allow-list did nothing.
 */
describe('embeddabilityOf', () => {
  const self = 'https://cowork.tracy.ai'

  it('frame-ancestors naming this origin is embeddable', () => {
    expect(embeddabilityOf({ reachable: true, frameAncestors: ["'self'", self] }, self)).toBe('embeddable')
  })

  it('frame-ancestors REPLACES X-Frame-Options, per CSP L2 §7.2', () => {
    // Joomla sends both: the PHP layer sets SAMEORIGIN and the fleet conf adds the CSP. A
    // browser honours the CSP and ignores the older header; judging by the header would send
    // every Tracy site through the host proxy for no reason.
    const probe = { reachable: true, xFrameOptions: 'SAMEORIGIN', frameAncestors: ["'self'", self] }
    expect(embeddabilityOf(probe, self)).toBe('embeddable')
  })

  it('frame-ancestors NOT naming this origin stays blocked', () => {
    expect(embeddabilityOf({ reachable: true, frameAncestors: ["'self'"] }, self)).toBe('blocked')
    expect(embeddabilityOf({ reachable: true, frameAncestors: ['https://elsewhere.example'] }, self)).toBe('blocked')
  })

  it('a host wildcard matches one label, not the bare domain', () => {
    const list = ['https://*.tracy.ai']
    expect(embeddabilityOf({ reachable: true, frameAncestors: list }, 'https://a-agent.tracy.ai')).toBe('embeddable')
    // `*.tracy.ai` does not cover `tracy.ai` itself — the same rule cookies and TLS certs use.
    expect(embeddabilityOf({ reachable: true, frameAncestors: list }, 'https://tracy.ai')).toBe('blocked')
  })

  it('a port wildcard matches any port on that host', () => {
    const list = ['http://127.0.0.1:*']
    expect(embeddabilityOf({ reachable: true, frameAncestors: list }, 'http://127.0.0.1:51740')).toBe('embeddable')
    expect(embeddabilityOf({ reachable: true, frameAncestors: list }, 'http://127.0.0.1:9')).toBe('embeddable')
    // Scheme still has to match.
    expect(embeddabilityOf({ reachable: true, frameAncestors: list }, 'https://127.0.0.1:51740')).toBe('blocked')
  })

  it('`*` allows everything, as before', () => {
    expect(embeddabilityOf({ reachable: true, frameAncestors: ['*'] }, self)).toBe('embeddable')
  })

  it('without frame-ancestors, X-Frame-Options still decides', () => {
    expect(embeddabilityOf({ reachable: true, xFrameOptions: 'SAMEORIGIN' }, self)).toBe('blocked')
    expect(embeddabilityOf({ reachable: true, xFrameOptions: 'DENY' }, self)).toBe('blocked')
    expect(embeddabilityOf({ reachable: true 	}, self)).toBe('embeddable')
  })

  it('an unreachable site is unknown, and the plain iframe stays', () => {
    expect(embeddabilityOf({ reachable: false }, self)).toBe('unknown')
  })

  it('no self origin given: fall back to the old, stricter reading', () => {
    // Callers that cannot say who they are must not be told "embeddable" on a list they were
    // never checked against.
    expect(embeddabilityOf({ reachable: true, frameAncestors: ["'self'", self] })).toBe('blocked')
    expect(embeddabilityOf({ reachable: true, frameAncestors: ['*'] })).toBe('embeddable')
  })
})

/**
 * Credentials a consumer plugin may attach to one framed request.
 *
 * WHY THE ROUTE CANNOT MINT THEM ITSELF. Signing a viewer into a site is a fact about the
 * DEPLOYMENT — which seat book, which session format, which header the site's login plugin
 * reads — and this plugin knows none of that. So it takes a provider instead: the consumer says
 * "for this host, send these", and the route carries them.
 *
 * WHAT IS GUARDED HERE. A provider is code, and code produces surprises: a header name with a
 * newline splits the request into two, and a `host` override sends the body somewhere else than
 * the URL that was checked. Both are refused rather than sanitised — a caller that meant it
 * should say so in the URL.
 */
describe('frameRequestHeaders', () => {
  const base = { accept: 'text/html' }

  it('no credentials leaves the base untouched', () => {
    expect(frameRequestHeaders(base, null)).toEqual(base)
    expect(frameRequestHeaders(base, {})).toEqual(base)
  })

  it('attaches a cookie and extra headers', () => {
    const out = frameRequestHeaders(base, { cookie: 'tracy_sess=v1.abc', headers: { 'x-tracy-tier': 'editor' } })
    expect(out.cookie).toBe('tracy_sess=v1.abc')
    expect(out['x-tracy-tier']).toBe('editor')
    expect(out.accept).toBe('text/html')
  })

  it('refuses a header that would rewrite where the request goes', () => {
    // `host` decides which virtual host answers; letting a provider set it means the URL the
    // SSRF guard checked is not the request that gets made.
    const out = frameRequestHeaders(base, { headers: { host: 'evil.example', Host: 'evil.example' } })
    expect(out.host).toBeUndefined()
    expect(out.Host).toBeUndefined()
  })

  it('refuses CRLF in a name or a value — that is request splitting', () => {
    const out = frameRequestHeaders(base, {
      cookie: 'a=1\r\nx-injected: 1',
      headers: { 'x-ok\r\n': 'v', 'x-bad': 'v\nmore: 1' }
    })
    expect(out.cookie).toBeUndefined()
    expect(out['x-ok\r\n']).toBeUndefined()
    expect(out['x-bad']).toBeUndefined()
  })

  it('does not let a provider overwrite the accept the route set', () => {
    // The route asks for a document; a provider turning that into something else would change
    // what the far side serves, and the route would then refuse its own request as "not a
    // document".
    const out = frameRequestHeaders(base, { headers: { accept: 'application/json' } })
    expect(out.accept).toBe('text/html')
  })
})
