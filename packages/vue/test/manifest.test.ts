import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { compile, NodeTypes, type ElementNode, type RootNode, type TemplateChildNode } from '@vue/compiler-dom'
import { describe, expect, it } from 'vitest'
import { defaultTheme, STYLE_KEYS, twClasses } from '@glassui/core'
// Import the generator first: it must load every built-in without a prior barrel import.
import { generateManifest, type GlassManifest } from '../src/manifest'
import { glassComponents } from '../src/define'
import { HOST_TAGS } from '../src/renderer'

const manifestPath = fileURLToPath(new URL('../manifest.json', import.meta.url))
const manifest = generateManifest()
const normalize = (name: string): string => name.replace(/-/g, '').toLowerCase()
const camelize = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
const builtins = new Set(['template', 'slot', 'component', 'Teleport', 'Transition', 'TransitionGroup', 'GlassTransition'].map(normalize))
const fallthrough = new Set(['class', 'style', 'tw', 'id', 'key', 'ref'])

function walkElements(node: RootNode | TemplateChildNode, visit: (el: ElementNode) => void): void {
  if (node.type === NodeTypes.ELEMENT) visit(node)
  if (node.type === NodeTypes.ROOT || node.type === NodeTypes.ELEMENT || node.type === NodeTypes.FOR) for (const child of node.children) walkElements(child, visit)
  if (node.type === NodeTypes.IF) for (const branch of node.branches) for (const child of branch.children) walkElements(child, visit)
}

/** Compile first, then inspect source AST nodes (including v-if/v-for branches). */
function validateExample(source: string, m: GlassManifest = manifest): string[] {
  const failures: string[] = []
  const { ast } = compile(source, { onError: e => failures.push(e.message), isCustomElement: tag => (HOST_TAGS as readonly string[]).includes(tag) })
  const byTag = new Map(m.components.map(c => [normalize(c.name), c]))
  walkElements(ast, el => {
    if ((HOST_TAGS as readonly string[]).includes(el.tag) || builtins.has(normalize(el.tag))) return
    const component = byTag.get(normalize(el.tag))
    if (!component) { failures.push(`unknown component ${el.tag}`); return }
    const props = new Set(component.props.map(p => p.name))
    const events = new Set(component.events.map(e => camelize(e.name)))
    for (const attr of el.props) {
      if (attr.type === NodeTypes.ATTRIBUTE) {
        if (!props.has(camelize(attr.name)) && !fallthrough.has(attr.name)) failures.push(`${el.tag}: unknown prop ${attr.name}`)
      } else if (attr.arg?.type === NodeTypes.SIMPLE_EXPRESSION && attr.arg.isStatic) {
        const name = camelize(attr.arg.content)
        if (attr.name === 'on' && !events.has(name)) failures.push(`${el.tag}: unknown event ${name}`)
        if (attr.name === 'bind' && !props.has(name) && !fallthrough.has(name)) failures.push(`${el.tag}: unknown prop ${name}`)
        if (attr.name === 'model' && (!props.has(name) || !events.has(`update:${name}`))) failures.push(`${el.tag}: unknown model ${name}`)
      } else if (attr.name === 'model' && (!props.has('modelValue') || !events.has('update:modelValue'))) failures.push(`${el.tag}: unknown model modelValue`)
    }
  })
  return failures
}

describe('generated manifest', () => {
  it('is up to date (and can bootstrap a missing file)', () => {
    const serialized = JSON.stringify(manifest, null, 2) + '\n'
    if (process.env.GLASSUI_WRITE_MANIFEST === '1') writeFileSync(manifestPath, serialized)
    expect(existsSync(manifestPath), 'manifest.json is missing: run `pnpm manifest`').toBe(true)
    expect(readFileSync(manifestPath, 'utf8'), 'manifest.json is stale: run `pnpm manifest`').toBe(serialized)
  })

  it('self-registers and completely documents all 21 components in stable name order', () => {
    const names = ['Surface', 'ScreenLayer', 'WorldLayer', 'Box', 'Text', 'Icon', 'Stack', 'Space', 'Block', 'Card', 'Viewport3D', 'BarChart3D', 'LineChart', 'SurfaceChart3D', 'BarMatrix3D', 'Button', 'Switch', 'Checkbox', 'Input', 'Dialog', 'GlassContainer'].sort()
    expect(manifest.components.map(c => c.name)).toEqual(names)
    const registry = glassComponents() as ReturnType<typeof glassComponents>[number][]
    const original = [...registry]
    try { registry.reverse(); expect(generateManifest()).toEqual(manifest) } finally { registry.splice(0, registry.length, ...original) }
    for (const c of manifest.components) {
      expect(c.description.length, c.name).toBeGreaterThan(40)
      expect(c.examples.length, c.name).toBeGreaterThanOrEqual(2)
      for (const p of c.props) expect(p.description, `${c.name}.${p.name}`).not.toBe('')
    }
  })

  it('preserves JSON Schema constraints, input requiredness, defaults, and model names', () => {
    const component = (name: string) => manifest.components.find(c => c.name === name)!
    const prop = (name: string, key: string) => component(name).props.find(p => p.name === key)!
    expect(prop('Surface', 'width')).toMatchObject({ required: true, type: { type: 'number', exclusiveMinimum: 0 } })
    expect(prop('Button', 'variant')).toMatchObject({ required: false, default: 'glass', type: { enum: ['glass', 'glassProminent', 'filled', 'tinted', 'plain'] } })
    expect(prop('Button', 'label').required).toBe(false)
    expect(prop('Button', 'label')).not.toHaveProperty('default')
    expect(prop('Switch', 'checked')).toMatchObject({ required: false, default: false })
    expect(prop('Viewport3D', 'object')).toMatchObject({ required: true, type: { description: expect.any(String) } })
    expect(component('Input').vModel).toEqual(['v-model'])
    expect(component('Switch').vModel).toEqual(['v-model:checked'])
    expect(component('Dialog').vModel).toEqual(['v-model:open'])
    expect(component('Space').vModel).toEqual(['v-model:focus'])
    expect(component('Button').vModel).toEqual([])
  })

  it('includes core style/theme vocabulary and returns independent deterministic JSON values', () => {
    expect(manifest.name).toBe('@glassui/vue')
    expect(manifest.style.keys.map(k => k.name)).toEqual(STYLE_KEYS)
    expect(manifest.style.keys.find(k => k.name === 'pointerEvents')?.type).toMatchObject({ enum: ['auto', 'none', 'box-none'] })
    expect(manifest.style.states).toEqual(['hover', 'pressed', 'focused', 'disabled'])
    expect(manifest.style.tw).toEqual(twClasses(defaultTheme))
    expect(twClasses({ ...defaultTheme, fontSize: { custom: 42 } })).toContain('text-custom')
    expect(manifest.theme).toEqual({ colors: Object.keys(defaultTheme.colors.light), fontSize: defaultTheme.fontSize, radius: defaultTheme.radius, spacing: defaultTheme.spacing, metrics: defaultTheme.metrics })
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest)
    const changed = generateManifest()
    changed.theme.spacing.push(999)
    changed.components.reverse()
    expect(generateManifest()).toEqual(manifest)
  })

  it('compiles every metadata example and validates component, prop, event and model names', () => {
    for (const c of manifest.components) for (const example of c.examples) expect(validateExample(example), `${c.name}: ${example}`).toEqual([])
  })

  it.each([
    ['<Buton />', 'unknown component'],
    ['<Button lable="Save" />', 'unknown prop'],
    ['<Button v-bind:bogus="x" />', 'unknown prop'],
    ['<Button @click="save" />', 'unknown event'],
    ['<Button v-on:prss="save" />', 'unknown event'],
    ['<Switch v-model="checked" />', 'unknown model'],
    ['<Button v-model:label="label" />', 'unknown model'],
    ['<Dialog v-model:opne="open" />', 'unknown model'],
    ['<Box><Button v-if="on" lable="x" /><Buton v-for="x in xs" :key="x" /></Box>', 'unknown'],
  ])('rejects invalid example %s', (example, expected) => expect(validateExample(example).join('; ')).toContain(expected))

  it('accepts host tags, Vue directives, slots, builtins and camelized names', () => {
    expect(validateExample('<box><Teleport to="overlay" defer><Transition><Button v-if="ok" trailing-icon="plus" @press="save" /></Transition></Teleport><Dialog v-model:open="open"><template #footer><Button label="Close" /></template></Dialog><Switch v-model:checked="on" /><Input v-model.trim="name" /><stack :gap="8" /></box>')).toEqual([])
  })

  it('documents runnable setup and current spatial/renderer limits', () => {
    expect(manifest.setup).toContain('createUIRoot')
    expect(manifest.setup).toContain('createGlassApp')
    expect(manifest.setup).toContain('setAnimationLoop')
    expect(manifest.setup).toContain('BarChart3D')
    const spatialTemplate = /<template>([\s\S]*?)<\/template>/.exec(manifest.setup)?.[1]
    expect(spatialTemplate).toBeDefined()
    expect(validateExample(spatialTemplate!)).toEqual([])
    for (const term of ['pointerEvents', 'KeepAlive', 'Suspense', 'defer', 'same live Surface', 'CameraRig', 'OrbitControls', 'fixed']) expect(manifest.rules.join('\n')).toContain(term)
    const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')
    for (const term of ['createUIRoot', 'createGlassApp', 'Surface', 'Stack', 'Text', 'Input', 'Button', 'Switch', 'Dialog', 'manifest.json']) expect(readme).toContain(term)
    const template = /<template>([\s\S]*?)<\/template>/.exec(readme)?.[1]
    expect(template).toBeDefined()
    expect(validateExample(template!)).toEqual([])
  })
})
