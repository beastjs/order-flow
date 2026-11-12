/// <reference types="@rsbuild/core/types" />

declare module '*.btsx' {
  const component: import('octane').ComponentBody<Record<string, unknown>>
  export default component
}
