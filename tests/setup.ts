/**
 * Vitest global setup.
 *
 * Node ≥ 22 defines a `localStorage` accessor on globalThis that resolves to
 * `undefined` unless the process was started with `--localstorage-file`
 * ("localStorage is not available because --localstorage-file was not
 * provided"). Because that key already exists, the jsdom environment's
 * global population never installs the document's own store, so a test
 * calling the bare global `localStorage` throws "Cannot read properties of
 * undefined" even though jsdom has a working one.
 *
 * Bridge the two: point the global at the jsdom window's Storage. The jsdom
 * environment exposes its instance as `globalThis.jsdom`; node-only suites
 * (no jsdom global) keep Node's accessor untouched.
 */
const jsdomWindow = (globalThis as { jsdom?: { window?: Window } }).jsdom?.window
const storage = jsdomWindow?.localStorage ?? (typeof window === 'undefined' ? undefined : window.localStorage)
if (storage !== undefined) {
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  })
}

// DSH 0.2.2-rc.2's Menu measures its child card with a ResizeObserver in a
// layout effect. jsdom (and node-only suites) have no ResizeObserver, and the
// menu throws during commit before any test body runs. A no-op observer is
// enough for tests: the host still measures once synchronously in the same
// effect, which is what sets `data-submenu-layout`.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    value: ResizeObserverStub,
    configurable: true,
    writable: true,
  })
}
