/** Build through the actual client CSS plugin: composition must survive emission, resolution and style injection. */
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { build } from 'tsdown'
import { createRequire } from 'node:module'
const { JSDOM } = createRequire(import.meta.url)('jsdom') as { JSDOM: new (html: string) => { window: Window } }
import configs from '../tsdown.config.ts'

it('emits local, global and transitive cross-file composition with dependency styles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sidebar-css-composition-'))
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>')
  const document = dom.window.document
  try {
    await writeFile(join(directory, 'base.module.css'), '.base { border: 1px solid; padding: 4px; } .primary { composes: base; background: rgb(12, 34, 56); }')
    await writeFile(join(directory, 'middle.module.css'), '.middle { composes: primary from "./base.module.css"; min-height: 32px; }')
    await writeFile(join(directory, 'action.module.css'), '.action { composes: middle from "./middle.module.css"; composes: shared from global; border-radius: 6px; }')
    await writeFile(join(directory, 'entry.ts'), 'import classes from "./action.module.css"; export { classes };')
    const client = configs.find(config => config.entry && typeof config.entry === 'object' && 'client' in config.entry)!
    await build({ config: false, entry: join(directory, 'entry.ts'), outDir: join(directory, 'dist'), format: 'iife', platform: 'browser', target: 'es2023', dts: false, sourcemap: false, clean: false, plugins: client.plugins, outputOptions: { name: 'fixture' } })
    const output = (await readdir(join(directory, 'dist'))).find(name => name.endsWith('.js'))!
    const context: { document: Document; fixture?: { classes: Record<string, string> } } = { document }
    runInNewContext(await readFile(join(directory, 'dist', output), 'utf8'), context)
    const classes = context.fixture!.classes.action!
    expect(classes.split(' ')).toHaveLength(5)
    expect(classes.split(' ')).toContain('shared')
    const button = document.createElement('button')
    button.className = classes
    document.body.append(button)
    const style = dom.window.getComputedStyle(button)
    expect(style.borderTopWidth).toBe('1px')
    expect(style.paddingTop).toBe('4px')
    expect(style.minHeight).toBe('32px')
    expect(style.borderRadius).toBe('6px')
    expect(style.backgroundColor).toBe('rgb(12, 34, 56)')
    const injected = [...document.querySelectorAll<HTMLStyleElement>('style[data-plugin]')]
    expect(injected.map(node => node.dataset.pluginCss?.split('/').at(-1))).toEqual(['base.module.css', 'middle.module.css', 'action.module.css'])
    button.remove()
    injected.forEach(node => { node.remove() })
  } finally {
    dom.window.close()
    await rm(directory, { recursive: true, force: true })
  }
})
