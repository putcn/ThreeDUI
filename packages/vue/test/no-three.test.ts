import { it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const files = (d: string): string[] => readdirSync(d).flatMap(f => statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)])

/** Inspect executable syntax, not imports quoted in manifest documentation or comments. */
function runtimeDependencies(source: string): string[] {
  const dependencies: string[] = []
  const add = (specifier: ts.Node | undefined): void => {
    if (specifier && ts.isStringLiteralLike(specifier) && /^(?:three|@glassui\/render)(?:$|\/)/.test(specifier.text)) dependencies.push(specifier.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) {
      const clause = node.importClause
      const onlyTypes = clause?.namedBindings && ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 && clause.namedBindings.elements.every(e => e.isTypeOnly) && !clause.name
      if (!onlyTypes) add(node.moduleSpecifier)
    } else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
      const onlyTypes = node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.length > 0 && node.exportClause.elements.every(e => e.isTypeOnly)
      if (!onlyTypes) add(node.moduleSpecifier)
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      add(node.arguments[0])
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression)
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
  return dependencies
}

it('the dependency guard catches multi-line imports and re-exports, and lets type-only ones through', () => {
  const runtime = [
    `import { A } from '@glassui/render'`, `import {\n  A,\n  B,\n} from '@glassui/render'`, `import { type A, B } from "@glassui/render"`,
    `export { A } from '@glassui/render'`, `export {\n  A,\n} from '@glassui/render'`, `export * from 'three'`, `import * as T from 'three'`,
    `import 'three'`, `import { X } from 'three/webgpu'`, `const m = await import('three')`, `const t = require('three')`,
  ]
  const typeOnly = [
    `import type { A } from '@glassui/render'`, `import type {\n  A,\n  B,\n} from '@glassui/render'`, `export type { A } from '@glassui/render'`,
    `import { A } from 'x'\nimport type { B } from '@glassui/render'`, `export { a }\nimport type { T } from '@glassui/render'`,
    `import { type A } from '@glassui/render'`, `export { type A } from '@glassui/render'`, `type A = import('three').Object3D`,
    `import { threeish } from './three-free'`, `import { X } from 'threejs-extras'`,
  ]
  for (const src of runtime) expect(runtimeDependencies(src), src).not.toEqual([])
  for (const src of typeOnly) expect(runtimeDependencies(src), src).toEqual([])
})
it('src never imports three or the render package at runtime', () => {
  const sources = files(fileURLToPath(new URL('../src', import.meta.url))).filter(f => f.endsWith('.ts'))
  expect(sources.length).toBeGreaterThan(0)
  for (const f of sources) expect(runtimeDependencies(readFileSync(f, 'utf8')), f).toEqual([])
})

it('ignores import examples in strings and comments while retaining executable imports', () => {
  const documentation = `const example = \`import { Scene } from 'three'\nimport { createUIRoot } from '@glassui/render'\`\n// import 'three'\n/* const x = require('three') */`
  expect(runtimeDependencies(documentation)).toEqual([])
  expect(runtimeDependencies(documentation + `\nconst actual = import('three/webgpu')`)).toEqual(['three/webgpu'])
})
