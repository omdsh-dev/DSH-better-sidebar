/**
 * Browser globals for specs that pull browser-bound modules. Import this
 * FIRST in a spec file: unlike statements after imports (which vitest
 * hoists above the module body), an import statement evaluates in order,
 * so this runs before any later import's module graph (xterm's UMD wrapper
 * checks `self` and its color defaults probe `document` at evaluation time;
 * window/localStorage are only touched at runtime by the store).
 */
const g = globalThis as Record<string, unknown>

if (g.self === undefined) g.self = globalThis

const elementStub = (): Record<string, unknown> => ({
  style: {},
  dataset: {},
  textContent: '',
  classList: { add: () => {}, remove: () => {}, contains: () => false },
  setAttribute: () => {},
  getAttribute: () => null,
  hasAttribute: () => false,
  appendChild: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  // xterm's color palette probe measures a canvas context at module load.
  getContext: () => null,
})

if (g.document === undefined) {
  g.document = {
    createElement: () => elementStub(),
    createDocumentFragment: () => elementStub(),
    addEventListener: () => {},
    removeEventListener: () => {},
    defaultView: globalThis,
    body: elementStub(),
    // CodeMirror's view module probes the UA and injects styles at load;
    // the plugin's css-inline prologue probes for existing style tags.
    documentElement: elementStub(),
    head: elementStub(),
    querySelector: () => null,
    querySelectorAll: () => [],
    styleSheets: [],
  }
}

if (g.navigator === undefined) {
  g.navigator = { userAgent: 'node', platform: 'node', vendor: '', maxTouchPoints: 0 }
}

if (g.window === undefined) {
  g.window = {
    clearTimeout: () => {},
    setTimeout: (_fn: () => void) => 0,
    innerWidth: 1024,
    innerHeight: 768,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    // desktop-env.ts reads the shell's URL stamps from location.search
    // (Sidebar renders with parseDesktopEnv even in specs).
    location: { search: '' },
  }
}

if (g.localStorage === undefined) {
  g.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
}
