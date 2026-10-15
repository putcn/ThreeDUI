// Single-file components, for tsc (Vite compiles them with @vitejs/plugin-vue; their templates are not type-checked here).
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent
  export default component
}
