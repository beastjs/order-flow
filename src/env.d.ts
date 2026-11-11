/// <reference types="vite/client" />

import { JSX } from 'octane/strong/jsx-runtime'

declare module '*.btsx' {
  const component: JSX.Element
  export default component
}
