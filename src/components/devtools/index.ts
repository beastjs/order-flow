import { Suspense, createElement, lazy, type OctaneNode } from 'octane'

// ─── App Devtools mount ──────────────────────────────────────────
// `import.meta.env.DEV` is a build-time constant: in production the
// ternary folds to `null`, the dynamic import is dead code, and the
// devtools chunk is never emitted. In dev it loads on first render.
const AppDevtools = import.meta.env.DEV ? lazy(() => import('./AppDevtools.btsx')) : null

export function DevtoolsMount(): OctaneNode {
  return AppDevtools ? createElement(Suspense, { fallback: null, children: createElement(AppDevtools, {}) }) : null
}
