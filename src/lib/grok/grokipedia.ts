export interface GrokipediaArticleLead {
  title: string | null
  factChecked: string | null
  leadHtml: string
  leadText: string
}

export interface GrokipediaRequest {
  page?: string
  query?: string
  url?: string
}

export interface GrokipediaArticleLeadResponse {
  page: string
  url: string
  data: GrokipediaArticleLead
}

interface ResolvedGrokipediaRequest {
  page: string
  url: string
}

interface ElementBounds {
  start: number
  openEnd: number
  innerEnd: number
  end: number
}

const DEFAULT_GROKIPEDIA_BASE_URL = 'https://grokipedia.com'
const GROKIPEDIA_HOSTS = new Set(['grokipedia.com', 'www.grokipedia.com'])
const GROKIPEDIA_PAGE_PREFIX = '/page/'
const GROKIPEDIA_TIMEOUT_MS = 15000
const FACT_CHECKED_WINDOW = 2000
const WHITESPACE = /\s+/
const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"'
}

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source'
])
const BLOCK_TAGS = new Set([
  'article',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'section',
  'table',
  'tr',
  'ul'
])
const TEXT_EXCLUDED_TAGS = new Set(['script', 'style'])

export class GrokipediaInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokipediaInputError'
  }
}

export class GrokipediaNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GrokipediaNotFoundError'
  }
}

export class GrokipediaUpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode = 502
  ) {
    super(message)
    this.name = 'GrokipediaUpstreamError'
  }
}

const normalizeInput = (value: string) => value.trim()

const requireInput = (value: string | undefined, label: string) => {
  const normalized = value ? normalizeInput(value) : ''

  if (!normalized) {
    throw new GrokipediaInputError(`Missing \`${label}\`.`)
  }

  return normalized
}

const normalizePage = (value: string) => {
  const normalized = requireInput(value, 'page')
  const withoutPrefix = normalized
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+/, '')
    .replace(/^page\//i, '')

  if (!withoutPrefix) {
    throw new GrokipediaInputError('`page` must include a Grokipedia page slug.')
  }

  return withoutPrefix.replace(/\/+$/, '')
}

const queryToPage = (value: string) => requireInput(value, 'query').replace(/\s+/g, '_')

const queryToPages = (value: string) => {
  const normalizedQuery = requireInput(value, 'query')
  const parts = normalizedQuery.split(/\s+/).filter(Boolean)
  const fullPage = queryToPage(normalizedQuery)

  if (parts.length <= 1) {
    return [fullPage]
  }

  return [...new Set([queryToPage(parts[0] ?? normalizedQuery), fullPage])]
}

const canonicalPageUrl = (page: string) =>
  `${DEFAULT_GROKIPEDIA_BASE_URL}${GROKIPEDIA_PAGE_PREFIX}${encodeURIComponent(page)}`

const toResolvedRequest = (page: string): ResolvedGrokipediaRequest => ({
  page,
  url: canonicalPageUrl(page)
})

const parsePageUrl = (value: string) => {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(requireInput(value, 'url'))
  } catch {
    throw new GrokipediaInputError('`url` must be a valid absolute URL.')
  }

  if (parsedUrl.protocol !== 'https:' || !GROKIPEDIA_HOSTS.has(parsedUrl.hostname)) {
    throw new GrokipediaInputError('`url` must point to `https://grokipedia.com/page/...`.')
  }

  if (!parsedUrl.pathname.startsWith(GROKIPEDIA_PAGE_PREFIX)) {
    throw new GrokipediaInputError('`url` must point to a Grokipedia `/page/...` path.')
  }

  const page = decodeURIComponent(parsedUrl.pathname.slice(GROKIPEDIA_PAGE_PREFIX.length)).replace(/\/+$/, '').trim()

  if (!page) {
    throw new GrokipediaInputError('`url` must include a Grokipedia page slug.')
  }

  return toResolvedRequest(page)
}

const resolveGrokipediaRequestCandidates = ({ page, query, url }: GrokipediaRequest): ResolvedGrokipediaRequest[] => {
  const providedFields = [
    ['page', page],
    ['query', query],
    ['url', url]
  ].filter(([, value]) => typeof value === 'string' && value.trim()) as Array<[string, string]>

  if (providedFields.length === 0) {
    throw new GrokipediaInputError('Provide one of `page`, `query`, or `url`.')
  }

  if (providedFields.length > 1) {
    throw new GrokipediaInputError('Provide only one of `page`, `query`, or `url`.')
  }

  if (url) {
    return [parsePageUrl(url)]
  }

  if (page) {
    const normalizedPage = normalizePage(page)

    return [toResolvedRequest(normalizedPage)]
  }

  return queryToPages(query ?? '').map(toResolvedRequest)
}

export const resolveGrokipediaRequest = (request: GrokipediaRequest) => resolveGrokipediaRequestCandidates(request)[0]

const decodeHtmlEntities = (value: string) =>
  value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, key: string) => {
    const normalizedKey = key.toLowerCase()

    if (normalizedKey in NAMED_HTML_ENTITIES) {
      return NAMED_HTML_ENTITIES[normalizedKey]
    }

    if (normalizedKey.startsWith('#x')) {
      const codePoint = Number.parseInt(normalizedKey.slice(2), 16)
      return Number.isNaN(codePoint) ? entity : String.fromCodePoint(codePoint)
    }

    if (normalizedKey.startsWith('#')) {
      const codePoint = Number.parseInt(normalizedKey.slice(1), 10)
      return Number.isNaN(codePoint) ? entity : String.fromCodePoint(codePoint)
    }

    return entity
  })

const stripInlineCitations = (value: string) => value.replace(/\[(?:\d+(?:\s*[-,]\s*\d+)*)\]/g, '')

const normalizeText = (value: string) =>
  stripInlineCitations(
    decodeHtmlEntities(value)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\f\v\r]+/g, ' ')
  )
    .split(/\n{2,}/)
    .map((paragraph) =>
      paragraph
        .replace(/\s*\n\s*/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
    )
    .filter(Boolean)
    .join('\n\n')

const resolveElementBounds = (html: string, tagName: string, openMatch: RegExpExecArray): ElementBounds | null => {
  if (openMatch.index < 0) {
    return null
  }

  const start = openMatch.index
  const openEnd = start + openMatch[0].length
  const tagRegex = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi')

  tagRegex.lastIndex = openEnd

  let depth = 1
  let tagMatch = tagRegex.exec(html)

  while (tagMatch) {
    const rawTag = tagMatch[0]
    const isClosingTag = /^<\//.test(rawTag)
    const isSelfClosingTag = /\/>$/.test(rawTag) || VOID_TAGS.has(tagName)

    if (!isClosingTag && !isSelfClosingTag) {
      depth += 1
    }

    if (isClosingTag) {
      depth -= 1

      if (depth === 0) {
        return {
          start,
          openEnd,
          innerEnd: tagMatch.index,
          end: tagMatch.index + rawTag.length
        }
      }
    }

    tagMatch = tagRegex.exec(html)
  }

  return null
}

const findElementBounds = (html: string, tagName: string): ElementBounds | null => {
  const openTagRegex = new RegExp(`<${tagName}\\b[^>]*>`, 'i')
  const openMatch = openTagRegex.exec(html)

  if (!openMatch) {
    return null
  }

  return resolveElementBounds(html, tagName, openMatch)
}

const stripFirstElement = (html: string, tagName: string) => {
  const bounds = findElementBounds(html, tagName)

  if (!bounds) {
    return html
  }

  return `${html.slice(0, bounds.start)}${html.slice(bounds.end)}`
}

const takeUntilElement = (html: string, tagName: string) => {
  const elementRegex = new RegExp(`<${tagName}\\b`, 'i')
  const matchIndex = html.search(elementRegex)
  return matchIndex === -1 ? html : html.slice(0, matchIndex)
}

const collectTtsBlocks = (html: string) => {
  const blocks: string[] = []
  const blockRegex = /<([a-z0-9:-]+)\b[^>]*\bdata-tts-block(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?[^>]*>/gi

  let match = blockRegex.exec(html)

  while (match) {
    const tagName = match[1]?.toLowerCase()

    if (!tagName) {
      match = blockRegex.exec(html)
      continue
    }

    const bounds = resolveElementBounds(html, tagName, match)

    if (!bounds) {
      match = blockRegex.exec(html)
      continue
    }

    blocks.push(html.slice(bounds.start, bounds.end).trim())
    blockRegex.lastIndex = bounds.end
    match = blockRegex.exec(html)
  }

  return blocks
}

const htmlFragmentToText = (html: string) => {
  let index = 0
  let text = ''
  let excludedDepth = 0

  while (index < html.length) {
    if (html.startsWith('<!--', index)) {
      const commentEnd = html.indexOf('-->', index + 4)
      index = commentEnd === -1 ? html.length : commentEnd + 3
      continue
    }

    if (html[index] === '<') {
      const tagEnd = html.indexOf('>', index + 1)

      if (tagEnd === -1) {
        break
      }

      const rawTag = html.slice(index + 1, tagEnd)
      const tagMatch = rawTag.match(/^\/?\s*([a-z0-9:-]+)/i)

      if (tagMatch) {
        const tagName = tagMatch[1].toLowerCase()
        const isClosingTag = rawTag.trimStart().startsWith('/')
        const isVoidTag = VOID_TAGS.has(tagName)
        const isBlockLikeTag =
          BLOCK_TAGS.has(tagName) ||
          (tagName === 'span' && /(?:\bdata-tts-block\b|class\s*=\s*["'][^"']*\bblock\b)/i.test(rawTag))

        if (!isClosingTag && TEXT_EXCLUDED_TAGS.has(tagName)) {
          excludedDepth += 1
        }

        if (excludedDepth === 0 && tagName === 'br') {
          text += '\n\n'
        }

        if (excludedDepth === 0 && isClosingTag && isBlockLikeTag && !text.endsWith('\n\n')) {
          text += '\n\n'
        }

        if (excludedDepth > 0 && isClosingTag && TEXT_EXCLUDED_TAGS.has(tagName)) {
          excludedDepth = Math.max(0, excludedDepth - 1)
        }

        if (!isClosingTag && !isVoidTag && isBlockLikeTag && text && !WHITESPACE.test(text.slice(-1))) {
          text += ' '
        }
      }

      index = tagEnd + 1
      continue
    }

    if (excludedDepth === 0) {
      const nextTagIndex = html.indexOf('<', index)
      const textChunk = html.slice(index, nextTagIndex === -1 ? html.length : nextTagIndex)
      text += textChunk.replace(/\s+/g, ' ')
      index = nextTagIndex === -1 ? html.length : nextTagIndex
      continue
    }

    index += 1
  }

  return normalizeText(text)
}

const FACT_CHECKED_PATTERN =
  /\bFact-checked by Grok\b(?:\s+(?:just now|yesterday|\d+\s+(?:minute|hour|day|week|month|year)s?\s+ago))?/gi

const findLastFactCheckedText = (html: string) => {
  const text = htmlFragmentToText(html)
  const matches = [...text.matchAll(FACT_CHECKED_PATTERN)]
  const lastMatch = matches.at(-1)

  return lastMatch ? lastMatch[0].trim() : null
}

const extractFactCheckedText = (html: string, articleBounds: ElementBounds, leadHtml: string) => {
  const preArticleHtml = html.slice(Math.max(0, articleBounds.start - FACT_CHECKED_WINDOW), articleBounds.start)
  return findLastFactCheckedText(preArticleHtml) ?? findLastFactCheckedText(leadHtml)
}

const stripFactCheckedText = (text: string, factChecked: string | null) => {
  if (!factChecked) {
    return text
  }

  const escapedFactChecked = factChecked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return normalizeText(text.replace(new RegExp(`\\b${escapedFactChecked}\\b`, 'i'), ' '))
}

export const extractGrokipediaArticleLead = (html: string): GrokipediaArticleLead | null => {
  const articleBounds = findElementBounds(html, 'article')

  if (!articleBounds) {
    return null
  }

  const articleHtml = html.slice(articleBounds.openEnd, articleBounds.innerEnd)
  const articleLeadHtml = takeUntilElement(articleHtml, 'h2').trim()
  const titleBounds = findElementBounds(articleLeadHtml, 'h1')
  const titleHtml = titleBounds ? articleLeadHtml.slice(titleBounds.start, titleBounds.end).trim() : ''
  const title = titleBounds
    ? htmlFragmentToText(articleLeadHtml.slice(titleBounds.openEnd, titleBounds.innerEnd))
    : null
  const factChecked = extractFactCheckedText(html, articleBounds, articleLeadHtml)
  const ttsBlocks = collectTtsBlocks(articleLeadHtml)
  const leadBodyHtml = ttsBlocks.length > 0 ? ttsBlocks.join('\n') : stripFirstElement(articleLeadHtml, 'h1')
  const leadText = stripFactCheckedText(htmlFragmentToText(leadBodyHtml), factChecked)
  const leadHtml = [titleHtml, ...ttsBlocks].filter(Boolean).join('\n').trim() || articleLeadHtml

  return {
    title,
    factChecked,
    leadHtml,
    leadText
  }
}

export const loadGrokipediaArticleLead = async (
  request: GrokipediaRequest,
  fetchImpl: typeof fetch = fetch
): Promise<GrokipediaArticleLeadResponse> => {
  const resolvedCandidates = resolveGrokipediaRequestCandidates(request)

  for (const resolved of resolvedCandidates) {
    let response: Response

    try {
      response = await fetchImpl(resolved.url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(GROKIPEDIA_TIMEOUT_MS)
      })
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new GrokipediaUpstreamError('Timed out while fetching Grokipedia.', 504)
      }

      throw new GrokipediaUpstreamError(
        error instanceof Error ? `Failed to fetch Grokipedia: ${error.message}` : 'Failed to fetch Grokipedia.'
      )
    }

    if (response.status === 404) {
      continue
    }

    if (!response.ok) {
      throw new GrokipediaUpstreamError(`Grokipedia upstream error ${response.status}.`)
    }

    const contentType = response.headers.get('content-type') ?? ''

    if (!contentType.includes('text/html')) {
      throw new GrokipediaUpstreamError(`Unexpected Grokipedia content type: ${contentType || 'unknown'}.`)
    }

    const html = await response.text()
    const data = extractGrokipediaArticleLead(html)

    if (!data) {
      throw new GrokipediaUpstreamError('Unexpected Grokipedia page structure: no `<article>` found.')
    }

    const finalUrl = response.url || resolved.url
    const finalPageMatch = finalUrl.match(/\/page\/([^/?#]+)/i)
    const finalPage = finalPageMatch ? decodeURIComponent(finalPageMatch[1]) : resolved.page

    return {
      page: finalPage,
      url: finalUrl,
      data
    }
  }

  const finalCandidate = resolvedCandidates.at(-1)
  throw new GrokipediaNotFoundError(`No Grokipedia page found for \`${finalCandidate?.page || 'unknown'}\`.`)
}
