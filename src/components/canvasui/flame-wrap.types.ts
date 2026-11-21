export interface FlameWrapOptions {
  color?: [number, number, number]
  intensity?: number
  height?: number
  spread?: number
  radius?: number
  speed?: number
  scale?: number
  turbulence?: number
  turbulenceScale?: number
  turbulenceReach?: number
  sparks?: number
  sparkSize?: number
  sparkDensity?: number
  sparkSpeed?: number
  rim?: number
  melt?: number
  distortion?: number
  smoke?: number
  ember?: number
  scorch?: number
}
export interface FlameWrapElements {
  source: HTMLCanvasElement
  content: HTMLElement
  output: HTMLCanvasElement
}
export interface FlameWrapInstance {
  setOptions: (options: FlameWrapOptions) => void
  resize: VoidFunction
  destroy: VoidFunction
}
export type PaintableCanvas = HTMLCanvasElement & {
  onpaint?: (() => void) | null
  requestPaint?: () => void
}
export type ElementImageContext = CanvasRenderingContext2D & {
  drawElementImage?: (element: Element, x: number, y: number) => void
}
export type DrawElementImage = { drawElementImage: (element: Element, x: number, y: number) => DOMMatrix | void }
export type HtmlInCanvasContext = CanvasRenderingContext2D & DrawElementImage
export type TransformGeometry = {
  updateElementGeometry?: (element: Element, options: { canvasTransform: DOMMatrix }) => void
}
export type HtmlInCanvasElement = HTMLCanvasElement & TransformGeometry
