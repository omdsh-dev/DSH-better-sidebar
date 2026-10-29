/**
 * Generates `src/client/mermaid-frame-asset.generated.ts`.
 *
 * The markdown preview renders mermaid diagrams inside a sandboxed iframe
 * (see src/client/mermaid-frame.ts): mermaid sizes every label with
 * `SVGElement.getBBox()`, and in the live DSH window that forces a layout
 * flush of the whole (large, style-heavy) document — measured at ~60-75ms per
 * measurement, so one diagram takes seconds and a document with dozens of
 * them keeps the renderer busy for minutes. An iframe has its own small
 * layout tree: the same measurement costs ~1ms.
 *
 * The frame must be self-contained (an opaque-origin sandboxed iframe cannot
 * fetch parent blob: subresources), so this build step inlines the UMD bundle
 * of the plugin's own `mermaid` dependency plus the tiny frame protocol into a
 * single HTML document. The document is embedded in the mermaid lazy chunk as
 * a string and turned into a blob: URL at runtime.
 *
 * Runs from `prepare` / `build` / `bundle` / `watch`, so a fresh install (and
 * a git-source install, which builds through `prepare`) always has the asset
 * before tsc/vitest/tsdown need it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const requireFromRepo = createRequire(import.meta.url)

/**
 * Locate mermaid's UMD bundle. Prefer the package subpath; fall back to the
 * package root + `dist/` so a restrictive `exports` map cannot break the
 * build.
 * @returns absolute path to mermaid.min.js.
 */
function mermaidBundlePath() {
  const candidates = []
  try {
    candidates.push(requireFromRepo.resolve('mermaid/dist/mermaid.min.js'))
  } catch {
    // Subpath not exported: fall through to the package-root candidate.
  }
  try {
    candidates.push(join(dirname(requireFromRepo.resolve('mermaid/package.json')), 'dist/mermaid.min.js'))
  } catch {
    // Mermaid missing entirely: the explicit error below explains the fix.
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'cannot locate mermaid/dist/mermaid.min.js — the mermaid dependency is not installed; run pnpm install first',
  )
}

const mermaidSource = readFileSync(mermaidBundlePath(), 'utf8')

/** The frame protocol. Runs inside the iframe (window.mermaid is the inlined
 * UMD bundle) and posts exactly one result/error per render request. */
const FRAME_API = `(function () {
  'use strict';
  var seq = 0;
  var MAX_SOURCE = 500000;
  function configure(theme) {
    window.mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      suppressErrorRendering: true,
      theme: theme === 'dark' ? 'dark' : 'default'
    });
  }
  function render(code, theme) {
    configure(theme);
    var id = 'dsh-frame-mermaid-' + (++seq);
    return window.mermaid.render(id, code).then(function (result) {
      return result && typeof result.svg === 'string' ? result.svg : '';
    });
  }
  window.__dshMermaidFrame = { render: render };
  if (window.parent !== window) {
    window.addEventListener('message', function (event) {
      // The parent is the only legitimate sender; the opaque-origin sandbox
      // cannot compare origins, so identity plus a strict payload schema is
      // the boundary (the host document must never be able to drive this
      // renderer with arbitrary content).
      if (event.source !== window.parent) return;
      var data = event.data;
      if (!data || typeof data !== 'object' || data.type !== 'mermaid-render') return;
      if (typeof data.id !== 'number' || !isFinite(data.id)) return;
      if (typeof data.code !== 'string' || data.code.length > MAX_SOURCE) return;
      var theme = data.theme === 'dark' ? 'dark' : 'default';
      render(data.code, theme).then(function (svg) {
        window.parent.postMessage({ type: 'mermaid-result', id: data.id, svg: svg }, '*');
      }).catch(function (error) {
        window.parent.postMessage({ type: 'mermaid-error', id: data.id, message: String((error && error.message) || error) }, '*');
      });
    });
    window.parent.postMessage({ type: 'mermaid-frame-ready' }, '*');
  }
})();`

/**
 * Inline a script body into an HTML `<script>` element. Only `</script` has
 * to be neutralized (`<\/script` is the same token to the JS lexer); the rest
 * of the source runs verbatim.
 * @param source - script source.
 * @returns the source, safe to place between `<script>` and `</script>`.
 */
function inlineScript(source) {
  return source.replace(/<\/script/gi, '<\\/script')
}

const frameHtml = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>mermaid frame</title>
<style>
  html, body { margin: 0; padding: 0; background: transparent; width: 1200px; }
  body { font: 13px/1.5 system-ui, sans-serif; }
</style>
</head>
<body>
<script>${inlineScript(mermaidSource)}</script>
<script>${inlineScript(FRAME_API)}</script>
</body>
</html>
`

/** The generated module. */
const generated = `/**
 * GENERATED by scripts/build-mermaid-frame-asset.mjs — do not edit.
 *
 * Self-contained mermaid iframe document (inline mermaid UMD + frame
 * protocol). See src/client/mermaid-frame.ts for why the preview renders
 * diagrams inside an iframe at all.
 */
// The explicit \`: string\` annotation keeps the ~3.5 MB literal out of the
// emitted .d.ts (otherwise tsc expands it into the declaration).
export const MERMAID_FRAME_HTML: string = ${JSON.stringify(frameHtml)}
`

const target = new URL('../src/client/mermaid-frame-asset.generated.ts', import.meta.url)
writeFileSync(target, generated)
console.log(
  'mermaid frame asset written:',
  `${(generated.length / 1024 / 1024).toFixed(2)} MB`,
  '(mermaid UMD',
  `${(mermaidSource.length / 1024 / 1024).toFixed(2)} MB)`,
)
