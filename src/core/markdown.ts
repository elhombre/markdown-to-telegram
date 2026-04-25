import { existsSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

import { renderBotHtml } from './renderers.js'
import type {
  AttachmentConfig,
  AttachmentItem,
  Block,
  Diagnostic,
  Inline,
  ListItem,
  MediaItem,
  PostDocument,
  PreparePostInput,
  PreparePostResult,
} from './types.js'

const markdownIt = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
})

interface BlockSpan {
  start: number
  end: number
  startLine: number
  endLine: number
  media?: MediaItem[]
}

function error(code: string, message: string): Diagnostic {
  return { level: 'error', code, message }
}

function warning(code: string, message: string): Diagnostic {
  return { level: 'warning', code, message }
}

export function compileMarkdownSource(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?-->/g, match => match.replace(/[^\n]/g, ''))
}

function normalizeAllowedExtensions(config?: AttachmentConfig): string[] {
  return (config?.allowedExtensions ?? []).map(extension => {
    const normalized = extension.trim().toLowerCase()
    if (normalized.length === 0) {
      return normalized
    }
    return normalized.startsWith('.') ? normalized : `.${normalized}`
  })
}

function resolveMediaSource(source: string, alt: string, baseDir?: string): MediaItem {
  if (/^https?:\/\//i.test(source)) {
    return { kind: 'remote-url', url: source, alt }
  }

  if (/^[A-Za-z0-9_-]{20,}$/.test(source)) {
    return { kind: 'telegram-file-id', fileId: source, alt }
  }

  return {
    kind: 'local-file',
    path: baseDir ? resolve(baseDir, source) : source,
    alt,
  }
}

function getMeaningfulInlineTokens(tokens: Token[]): Token[] {
  return tokens.filter(token => {
    if (token.type === 'text') {
      return token.content.trim().length > 0
    }

    return token.type !== 'softbreak' && token.type !== 'hardbreak'
  })
}

function getMediaParagraph(tokens: Token[], baseDir?: string): MediaItem[] | undefined {
  const meaningfulTokens = getMeaningfulInlineTokens(tokens)

  if (meaningfulTokens.length === 0 || meaningfulTokens.some(token => token.type !== 'image')) {
    return undefined
  }

  return meaningfulTokens.flatMap(token => {
    const source = token.attrGet('src')
    if (!source) {
      return []
    }

    return [resolveMediaSource(source, token.content, baseDir)]
  })
}

function collectTopLevelSpans(tokens: Token[], baseDir?: string): BlockSpan[] {
  const spans: BlockSpan[] = []

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) {
      continue
    }

    switch (token.type) {
      case 'paragraph_open': {
        const inline = tokens[index + 1]
        const close = tokens[index + 2]
        if (!inline || inline.type !== 'inline' || !close || close.type !== 'paragraph_close') {
          continue
        }

        const media = getMediaParagraph(inline.children ?? [], baseDir)
        const [startLine, endLine] = token.map ?? [0, 0]
        spans.push({
          start: index,
          end: index + 3,
          startLine,
          endLine,
          media,
        })
        index += 2
        break
      }
      case 'heading_open': {
        const closeIndex = index + 2
        const [startLine, endLine] = token.map ?? [0, 0]
        spans.push({ start: index, end: closeIndex + 1, startLine, endLine })
        index = closeIndex
        break
      }
      case 'bullet_list_open':
      case 'ordered_list_open':
      case 'blockquote_open': {
        const [, end] = findBlockRange(tokens, index)
        const [startLine, endLine] = token.map ?? [0, 0]
        spans.push({ start: index, end, startLine, endLine })
        index = end - 1
        break
      }
      case 'fence':
      case 'code_block':
      case 'hr':
      case 'html_block': {
        const [startLine, endLine] = token.map ?? [0, 0]
        spans.push({ start: index, end: index + 1, startLine, endLine })
        break
      }
      default:
        break
    }
  }

  return spans
}

function findBlockRange(tokens: Token[], startIndex: number): [number, number] {
  const openToken = tokens[startIndex]
  if (!openToken) {
    return [startIndex, startIndex + 1]
  }

  const closeType = openToken.type.replace('_open', '_close')
  let depth = 0

  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token) {
      continue
    }

    if (token.type === openToken.type) {
      depth += 1
    } else if (token.type === closeType) {
      depth -= 1
      if (depth === 0) {
        return [startIndex, index + 1]
      }
    }
  }

  return [startIndex, tokens.length]
}

function sliceBodyMarkdown(
  markdown: string,
  spans: BlockSpan[],
  input: PreparePostInput,
): { document: PostDocument; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const lines = markdown.split(/\r?\n/)
  const leadingMedia: BlockSpan[] = []
  const trailingMedia: BlockSpan[] = []

  for (const span of spans) {
    if (span.media) {
      leadingMedia.push(span)
      continue
    }
    break
  }

  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]
    if (span?.media) {
      trailingMedia.unshift(span)
      continue
    }
    break
  }

  const hasLeadingMedia = leadingMedia.length > 0
  const hasTrailingMedia = trailingMedia.length > 0
  const hasMediaOnBothSides =
    hasLeadingMedia &&
    hasTrailingMedia &&
    leadingMedia.length < spans.length &&
    trailingMedia.length < spans.length &&
    leadingMedia[0]?.start !== trailingMedia[0]?.start

  if (hasMediaOnBothSides) {
    diagnostics.push(
      error('UNSUPPORTED_MEDIA_PLACEMENT', 'Media blocks on both sides of the text body are not supported in v1.'),
    )
  }

  let mediaPosition: PostDocument['mediaPosition'] = 'none'
  let media: MediaItem[] = []
  let bodyStartLine = 0
  let bodyEndLine = lines.length

  if (hasLeadingMedia && !hasMediaOnBothSides) {
    mediaPosition = 'media-first'
    media = leadingMedia.flatMap(span => span.media ?? [])
    bodyStartLine = leadingMedia.at(-1)?.endLine ?? 0
  } else if (hasTrailingMedia && !hasMediaOnBothSides) {
    mediaPosition = 'text-first'
    media = trailingMedia.flatMap(span => span.media ?? [])
    bodyEndLine = trailingMedia[0]?.startLine ?? lines.length
  }

  const bodyMarkdown = lines.slice(bodyStartLine, bodyEndLine).join('\n').trim()
  const bodyTokens = markdownIt.parse(bodyMarkdown, {})
  const bodySpans = collectTopLevelSpans(bodyTokens)

  if (bodySpans.some(span => span.media)) {
    diagnostics.push(
      error(
        'UNSUPPORTED_INLINE_MEDIA_GROUPS',
        'Only one contiguous media group at the top or bottom of the document is supported in v1.',
      ),
    )
  }

  const blocks = parseBlocks(bodyTokens, diagnostics)

  if (blocks.length === 0) {
    diagnostics.push(error('EMPTY_POST_BODY', 'Post body is empty after parsing.'))
  }

  return {
    document: {
      mediaPosition,
      media,
      ...extractAttachmentSection(blocks, diagnostics, input),
    },
    diagnostics,
  }
}

function extractAttachmentSection(
  blocks: Block[],
  diagnostics: Diagnostic[],
  input: PreparePostInput,
): Pick<PostDocument, 'blocks' | 'attachments'> {
  const attachmentConfig = input.attachmentConfig
  if (!attachmentConfig) {
    return { blocks, attachments: [] }
  }

  const sectionTitle = attachmentConfig?.sectionTitle?.trim() || 'Attachments'
  const allowedExtensions = normalizeAllowedExtensions(attachmentConfig)
  const matches: number[] = []

  for (const [index, block] of blocks.entries()) {
    if (block.type !== 'heading' || block.level !== 2) {
      continue
    }

    if (normalizeText(extractInlineText(block.content)) === normalizeText(sectionTitle)) {
      matches.push(index)
    }
  }

  if (matches.length === 0) {
    return { blocks, attachments: [] }
  }

  if (matches.length > 1) {
    diagnostics.push(
      error(
        'DUPLICATE_ATTACHMENTS_SECTION',
        `Only one "${sectionTitle}" section is supported, but ${matches.length} matching sections were found.`,
      ),
    )
  }

  const startIndex = matches[0] ?? -1
  if (startIndex < 0) {
    return { blocks, attachments: [] }
  }

  let endIndex = blocks.length
  for (let index = startIndex + 1; index < blocks.length; index += 1) {
    const block = blocks[index]
    if (block?.type === 'heading' && block.level <= 2) {
      endIndex = index
      break
    }
  }

  const sectionBlocks = blocks.slice(startIndex + 1, endIndex)
  if (sectionBlocks.length === 0) {
    diagnostics.push(error('EMPTY_ATTACHMENTS_SECTION', `The "${sectionTitle}" section must contain a list of links.`))
  }

  const attachments: AttachmentItem[] = []
  for (const block of sectionBlocks) {
    if (block.type !== 'list') {
      diagnostics.push(
        error('INVALID_ATTACHMENTS_SECTION_CONTENT', `The "${sectionTitle}" section may contain list items only.`),
      )
      continue
    }

    attachments.push(...parseAttachmentList(block, diagnostics, input.baseDir, allowedExtensions))
  }

  return {
    blocks: [...blocks.slice(0, startIndex), ...blocks.slice(endIndex)],
    attachments,
  }
}

function parseAttachmentList(
  block: Extract<Block, { type: 'list' }>,
  diagnostics: Diagnostic[],
  baseDir: string | undefined,
  allowedExtensions: string[],
): AttachmentItem[] {
  const attachments: AttachmentItem[] = []

  for (const item of block.items) {
    const attachment = parseAttachmentListItem(item.blocks, diagnostics, baseDir, allowedExtensions)
    if (attachment) {
      attachments.push(attachment)
    }
  }

  return attachments
}

function parseAttachmentListItem(
  blocks: Block[],
  diagnostics: Diagnostic[],
  baseDir: string | undefined,
  allowedExtensions: string[],
): AttachmentItem | undefined {
  if (blocks.length !== 1 || blocks[0]?.type !== 'paragraph') {
    diagnostics.push(
      error(
        'INVALID_ATTACHMENT_ENTRY',
        'Each attachment list item must contain exactly one paragraph with a single named local-file link.',
      ),
    )
    return undefined
  }

  const paragraph = blocks[0]
  const meaningfulInline = paragraph.content.filter(token => {
    return token.type !== 'text' || token.value.trim().length > 0
  })

  if (meaningfulInline.length !== 1 || meaningfulInline[0]?.type !== 'link') {
    diagnostics.push(
      error(
        'INVALID_ATTACHMENT_ENTRY',
        'Each attachment list item must contain exactly one named local-file link and no extra text.',
      ),
    )
    return undefined
  }

  const link = meaningfulInline[0]
  const label = extractInlineText(link.children).trim()
  if (label.length === 0) {
    diagnostics.push(error('ATTACHMENT_LABEL_REQUIRED', 'Each attachment link must have a visible text label.'))
    return undefined
  }

  if (/^https?:\/\//i.test(link.href)) {
    diagnostics.push(
      error(
        'REMOTE_ATTACHMENT_UNSUPPORTED',
        'The attachments section only supports local file links, not external URLs.',
      ),
    )
    return undefined
  }

  const resolvedPath = baseDir ? resolve(baseDir, link.href) : link.href
  if (!existsSync(resolvedPath)) {
    diagnostics.push(error('LOCAL_ATTACHMENT_NOT_FOUND', `Attachment file was not found: ${resolvedPath}`))
    return undefined
  }

  const extension = extname(resolvedPath).toLowerCase()
  if (allowedExtensions.length === 0 || !allowedExtensions.includes(extension)) {
    diagnostics.push(
      error(
        'ATTACHMENT_EXTENSION_NOT_ALLOWED',
        `Attachment "${resolvedPath}" uses extension "${extension || '(none)'}", which is not allowed by configuration.`,
      ),
    )
    return undefined
  }

  return {
    path: resolvedPath,
    label,
    extension,
  }
}

function extractInlineText(inline: Inline[]): string {
  return inline
    .map(token => {
      switch (token.type) {
        case 'text':
          return token.value
        case 'code':
          return token.value
        case 'break':
          return ' '
        case 'bold':
        case 'italic':
        case 'strike':
        case 'link':
          return extractInlineText(token.children)
      }

      return ''
    })
    .join('')
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase()
}

function parseBlocks(tokens: Token[], diagnostics: Diagnostic[]): Block[] {
  const parser = new BlockParser(tokens, diagnostics)
  return parser.parse()
}

class BlockParser {
  private readonly tokens: Token[]
  private readonly diagnostics: Diagnostic[]
  private index = 0

  constructor(tokens: Token[], diagnostics: Diagnostic[]) {
    this.tokens = tokens
    this.diagnostics = diagnostics
  }

  parse(): Block[] {
    const blocks: Block[] = []

    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]

      switch (token?.type) {
        case 'heading_open':
          blocks.push(this.parseHeading())
          break
        case 'paragraph_open':
          blocks.push(this.parseParagraph())
          break
        case 'bullet_list_open':
          blocks.push(this.parseList(false))
          break
        case 'ordered_list_open':
          blocks.push(this.parseList(true))
          break
        case 'blockquote_open':
          blocks.push(this.parseBlockquote())
          break
        case 'fence':
        case 'code_block':
          blocks.push(this.parseCodeBlock(token))
          this.index += 1
          break
        case 'hr':
          blocks.push({ type: 'rule' })
          this.index += 1
          break
        case 'html_block':
          this.diagnostics.push(error('UNSUPPORTED_HTML_BLOCK', 'Raw HTML blocks are not supported in v1.'))
          this.index += 1
          break
        default:
          this.index += 1
          break
      }
    }

    return blocks
  }

  private parseHeading(): Block {
    const open = this.expect('heading_open')
    const inline = this.expect('inline')
    this.expect('heading_close')
    const level = Number(open.tag.slice(1))

    return {
      type: 'heading',
      level: clampHeadingLevel(level),
      content: parseInlineTokens(inline.children ?? [], this.diagnostics),
    }
  }

  private parseParagraph(): Block {
    this.expect('paragraph_open')
    const inline = this.expect('inline')
    this.expect('paragraph_close')

    return {
      type: 'paragraph',
      content: parseInlineTokens(inline.children ?? [], this.diagnostics),
    }
  }

  private parseList(ordered: boolean): Block {
    const open = this.expect(ordered ? 'ordered_list_open' : 'bullet_list_open')
    const start = Number(open.attrGet('start') ?? '1')
    const items: ListItem[] = []

    while (
      this.index < this.tokens.length &&
      this.tokens[this.index]?.type !== `${ordered ? 'ordered' : 'bullet'}_list_close`
    ) {
      items.push(this.parseListItem())
    }

    this.expect(`${ordered ? 'ordered' : 'bullet'}_list_close`)

    if (ordered && start !== 1) {
      this.diagnostics.push(
        warning('ORDERED_LIST_START_IGNORED', 'Ordered list start offsets are normalized to 1 in v1.'),
      )
    }

    return {
      type: 'list',
      ordered,
      items,
    }
  }

  private parseListItem(): ListItem {
    this.expect('list_item_open')
    const blocks: Block[] = []

    while (this.index < this.tokens.length && this.tokens[this.index]?.type !== 'list_item_close') {
      const token = this.tokens[this.index]

      switch (token?.type) {
        case 'paragraph_open':
          blocks.push(this.parseParagraph())
          break
        case 'bullet_list_open':
          blocks.push(this.parseList(false))
          break
        case 'ordered_list_open':
          blocks.push(this.parseList(true))
          break
        case 'blockquote_open':
          blocks.push(this.parseBlockquote())
          break
        case 'fence':
        case 'code_block':
          blocks.push(this.parseCodeBlock(token))
          this.index += 1
          break
        default:
          this.index += 1
          break
      }
    }

    this.expect('list_item_close')
    return { blocks }
  }

  private parseBlockquote(): Block {
    this.expect('blockquote_open')
    const blocks: Block[] = []

    while (this.index < this.tokens.length && this.tokens[this.index]?.type !== 'blockquote_close') {
      const token = this.tokens[this.index]

      switch (token?.type) {
        case 'paragraph_open':
          blocks.push(this.parseParagraph())
          break
        case 'bullet_list_open':
          blocks.push(this.parseList(false))
          break
        case 'ordered_list_open':
          blocks.push(this.parseList(true))
          break
        case 'fence':
        case 'code_block':
          blocks.push(this.parseCodeBlock(token))
          this.index += 1
          break
        default:
          this.index += 1
          break
      }
    }

    this.expect('blockquote_close')
    return { type: 'blockquote', blocks }
  }

  private parseCodeBlock(token: Token): Block {
    const language = token.info.trim().split(/\s+/)[0]
    return {
      type: 'code',
      language: language || undefined,
      content: token.content,
    }
  }

  private expect(type: string): Token {
    const token = this.tokens[this.index]
    if (!token || token.type !== type) {
      throw new Error(`Unexpected token. Expected "${type}", got "${token?.type ?? 'EOF'}".`)
    }
    this.index += 1
    return token
  }
}

function clampHeadingLevel(level: number): 1 | 2 | 3 | 4 | 5 | 6 {
  if (level < 1) {
    return 1
  }
  if (level > 6) {
    return 6
  }
  return level as 1 | 2 | 3 | 4 | 5 | 6
}

function parseInlineTokens(tokens: Token[], diagnostics: Diagnostic[]): Inline[] {
  const root: Inline[] = []
  const stack: Inline[][] = [root]

  const current = () => stack[stack.length - 1] ?? root

  const pushContainer = (kind: Extract<Inline['type'], 'bold' | 'italic' | 'strike' | 'link'>, href?: string) => {
    const children: Inline[] = []
    let container: Inline

    if (kind === 'link') {
      container = { type: 'link', href: href ?? '#', children }
    } else {
      container = { type: kind, children } as Extract<Inline, { type: typeof kind }>
    }

    current().push(container)
    stack.push(children)
  }

  const popContainer = () => {
    if (stack.length > 1) {
      stack.pop()
    }
  }

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        current().push({ type: 'text', value: token.content })
        break
      case 'softbreak':
      case 'hardbreak':
        current().push({ type: 'break' })
        break
      case 'code_inline':
        current().push({ type: 'code', value: token.content })
        break
      case 'em_open':
        pushContainer('italic')
        break
      case 'em_close':
        popContainer()
        break
      case 'strong_open':
        pushContainer('bold')
        break
      case 'strong_close':
        popContainer()
        break
      case 's_open':
        pushContainer('strike')
        break
      case 's_close':
        popContainer()
        break
      case 'link_open':
        pushContainer('link', token.attrGet('href') ?? '#')
        break
      case 'link_close':
        popContainer()
        break
      case 'image':
        diagnostics.push(
          error(
            'UNSUPPORTED_INLINE_IMAGE',
            'Images are only supported as standalone top or bottom media blocks in v1.',
          ),
        )
        break
      default:
        if (token.content) {
          current().push({ type: 'text', value: token.content })
        }
        break
    }
  }

  while (stack.length > 1) {
    stack.pop()
  }

  return root
}

export function preparePost(input: PreparePostInput): PreparePostResult {
  const sanitizedMarkdown = compileMarkdownSource(input.markdown)
  const spans = collectTopLevelSpans(markdownIt.parse(sanitizedMarkdown, {}), input.baseDir)
  const { document, diagnostics } = sliceBodyMarkdown(sanitizedMarkdown, spans, input)

  return {
    document,
    renderedHtml: renderBotHtml(document.blocks, input.renderConfig),
    diagnostics,
  }
}
