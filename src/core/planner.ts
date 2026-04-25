import { renderBotHtml } from './renderers.js'
import type { Block, Diagnostic, Inline, PlanPostInput, PublishPlan, PublishStep, SplitRulesConfig } from './types.js'

interface ChunkTakeResult {
  chunkBlocks: Block[]
  remainingBlocks: Block[]
  diagnostics: Diagnostic[]
}

interface BlockSplitResult {
  head?: Block
  tail?: Block
}

interface SplitUnit {
  blocks: Block[]
  blockCount: number
}

interface InlineWrapper {
  type: 'bold' | 'italic' | 'strike' | 'link'
  href?: string
}

type InlineSegment =
  | { type: 'text'; value: string; wrappers: InlineWrapper[] }
  | { type: 'code'; value: string; wrappers: InlineWrapper[] }
  | { type: 'break'; wrappers: InlineWrapper[] }

function error(code: string, message: string): Diagnostic {
  return { level: 'error', code, message }
}

function warning(code: string, message: string): Diagnostic {
  return { level: 'warning', code, message }
}

export function planPost(input: PlanPostInput): PublishPlan {
  const diagnostics = validateBasePlanInput(input)

  if (diagnostics.some(diagnostic => diagnostic.level === 'error')) {
    return { target: input.capabilities.target, steps: [], diagnostics }
  }

  const overflowMode = input.overflowMode ?? 'fail'

  if (overflowMode === 'split') {
    return planSplitPost(input, diagnostics)
  }

  return planFailFastPost(input, diagnostics)
}

function validateBasePlanInput(input: PlanPostInput): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const media = input.document.media
  const capabilities = input.capabilities

  if (input.document.blocks.length === 0) {
    diagnostics.push(error('EMPTY_POST_BODY', 'Post body is empty.'))
  }

  if (media.length > 1 && media.length > capabilities.mediaGroupMaxItems) {
    diagnostics.push(
      error(
        'TOO_MANY_MEDIA_ITEMS',
        `Media groups support up to ${capabilities.mediaGroupMaxItems} items, but ${media.length} were provided.`,
      ),
    )
  }
  return diagnostics
}

function planFailFastPost(input: PlanPostInput, diagnostics: Diagnostic[]): PublishPlan {
  const steps: PublishStep[] = []
  const html = input.renderedHtml.bodyHtml
  const media = input.document.media
  const capabilities = input.capabilities

  if (html.length > capabilities.messageLimit) {
    diagnostics.push(
      error(
        'MESSAGE_TOO_LONG',
        `Rendered HTML is ${html.length} characters long and exceeds the ${capabilities.messageLimit}-character message limit.`,
      ),
    )
  }

  if (diagnostics.some(diagnostic => diagnostic.level === 'error')) {
    return { target: capabilities.target, steps, diagnostics }
  }

  if (media.length === 0 || input.document.mediaPosition === 'none') {
    steps.push({ type: 'send-message', html })
    appendAttachmentSteps(steps, input)
    return { target: capabilities.target, steps, diagnostics }
  }

  if (input.document.mediaPosition === 'media-first') {
    if (html.length > capabilities.captionLimit) {
      diagnostics.push(
        error(
          'CAPTION_TOO_LONG',
          `Rendered HTML is ${html.length} characters long and exceeds the ${capabilities.captionLimit}-character caption limit.`,
        ),
      )
      return { target: capabilities.target, steps, diagnostics }
    }

    const mediaStep = createMediaStep(media, html, diagnostics, input.document.mediaPosition)
    if (!mediaStep) {
      return { target: capabilities.target, steps, diagnostics }
    }

    steps.push(mediaStep)
    appendAttachmentSteps(steps, input)
    return { target: capabilities.target, steps, diagnostics }
  }

  steps.push({ type: 'send-message', html })

  const mediaStep = createMediaStep(media, undefined, diagnostics, input.document.mediaPosition)
  if (!mediaStep) {
    return { target: capabilities.target, steps, diagnostics }
  }

  steps.push(mediaStep)
  appendAttachmentSteps(steps, input)
  return { target: capabilities.target, steps, diagnostics }
}

function planSplitPost(input: PlanPostInput, diagnostics: Diagnostic[]): PublishPlan {
  const steps: PublishStep[] = []
  const capabilities = input.capabilities
  const continuationBlocks = input.continuationBlocks ?? []
  const continuationHtml = renderBlocks(continuationBlocks, input.renderConfig)
  const splitRules = normalizeSplitRules(input.splitRules)

  if (continuationHtml.length > capabilities.messageLimit) {
    diagnostics.push(
      error(
        'CONTINUATION_PREAMBLE_TOO_LONG',
        `Continuation preamble renders to ${continuationHtml.length} characters and exceeds the ${capabilities.messageLimit}-character message limit.`,
      ),
    )
  }

  if (diagnostics.some(diagnostic => diagnostic.level === 'error')) {
    return { target: capabilities.target, steps, diagnostics }
  }

  if (input.document.media.length === 0 || input.document.mediaPosition === 'none') {
    const textChunks = splitBlocksIntoChunks(
      input.document.blocks,
      capabilities.messageLimit,
      capabilities.messageLimit,
      continuationBlocks,
      false,
      input.renderConfig,
      splitRules,
    )

    diagnostics.push(...textChunks.diagnostics)
    if (diagnostics.some(diagnostic => diagnostic.level === 'error')) {
      return { target: capabilities.target, steps, diagnostics }
    }

    steps.push(
      ...textChunks.chunks.map(
        blocks => ({ type: 'send-message', html: renderBlocks(blocks, input.renderConfig) }) satisfies PublishStep,
      ),
    )
    appendAttachmentSteps(steps, input)
    return { target: capabilities.target, steps, diagnostics }
  }

  if (input.document.mediaPosition === 'text-first') {
    diagnostics.push(
      warning(
        'TEXT_FIRST_MEDIA_FORCED_TO_MEDIA_FIRST',
        'Split overflow mode publishes media posts with the media step first so caption space can be used before continuation messages.',
      ),
    )
  }

  const mediaCaptionSplit = splitBlocksIntoChunks(
    input.document.blocks,
    capabilities.captionLimit,
    capabilities.messageLimit,
    continuationBlocks,
    true,
    input.renderConfig,
    splitRules,
  )

  diagnostics.push(...mediaCaptionSplit.diagnostics)
  if (diagnostics.some(diagnostic => diagnostic.level === 'error')) {
    return { target: capabilities.target, steps, diagnostics }
  }

  const firstChunk = mediaCaptionSplit.chunks[0] ?? []
  const continuationChunks = mediaCaptionSplit.chunks.slice(1)
  const caption = firstChunk.length > 0 ? renderBlocks(firstChunk, input.renderConfig) : undefined

  const mediaStep = createMediaStep(input.document.media, caption, diagnostics, 'media-first')
  if (!mediaStep) {
    return { target: capabilities.target, steps, diagnostics }
  }

  steps.push(mediaStep)
  steps.push(
    ...continuationChunks.map(
      blocks =>
        ({
          type: 'send-message',
          html: renderBlocks(blocks, input.renderConfig),
        }) satisfies PublishStep,
    ),
  )
  appendAttachmentSteps(steps, input)

  return { target: capabilities.target, steps, diagnostics }
}

function appendAttachmentSteps(steps: PublishStep[], input: PlanPostInput): void {
  steps.push(
    ...input.document.attachments.map(
      attachment =>
        ({
          type: 'send-document',
          attachment,
          caption: attachment.label,
        }) satisfies PublishStep,
    ),
  )
}

function createMediaStep(
  media: PlanPostInput['document']['media'],
  caption: string | undefined,
  diagnostics: Diagnostic[],
  mode: 'media-first' | 'text-first',
): PublishStep | undefined {
  if (media.length === 1) {
    const firstMedia = media[0]
    if (!firstMedia) {
      diagnostics.push(error('MISSING_MEDIA', `Expected a media item for a ${mode} post.`))
      return undefined
    }

    return {
      type: 'send-photo',
      media: firstMedia,
      caption,
    }
  }

  return {
    type: 'send-media-group',
    media,
    caption,
  }
}

function splitBlocksIntoChunks(
  blocks: Block[],
  firstLimit: number,
  continuationLimit: number,
  continuationBlocks: Block[],
  allowEmptyFirstChunk: boolean,
  renderConfig?: PlanPostInput['renderConfig'],
  splitRules: NormalizedSplitRules = normalizeSplitRules(),
): { chunks: Block[][]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = []
  const chunks: Block[][] = []
  let remainingBlocks = [...blocks]
  let firstChunk = true

  while (remainingBlocks.length > 0) {
    const chunk = takeChunkFromBlocks(
      remainingBlocks,
      firstChunk ? firstLimit : continuationLimit,
      firstChunk ? [] : continuationBlocks,
      firstChunk && allowEmptyFirstChunk,
      renderConfig,
      splitRules,
    )

    diagnostics.push(...chunk.diagnostics)
    if (chunk.diagnostics.some(diagnostic => diagnostic.level === 'error')) {
      return { chunks, diagnostics }
    }

    if (chunk.chunkBlocks.length === 0) {
      if (firstChunk && allowEmptyFirstChunk) {
        chunks.push([])
        firstChunk = false
        continue
      }

      diagnostics.push(error('EMPTY_CONTINUATION_CHUNK', 'Failed to produce a non-empty continuation chunk.'))
      return { chunks, diagnostics }
    }

    chunks.push(chunk.chunkBlocks)
    remainingBlocks = chunk.remainingBlocks
    firstChunk = false
  }

  if (chunks.length === 0) {
    chunks.push([])
  }

  return { chunks, diagnostics }
}

function takeChunkFromBlocks(
  blocks: Block[],
  limit: number,
  prefixBlocks: Block[],
  allowEmptyChunk: boolean,
  renderConfig?: PlanPostInput['renderConfig'],
  splitRules: NormalizedSplitRules = normalizeSplitRules(),
): ChunkTakeResult {
  const diagnostics: Diagnostic[] = []
  const contentBlocks: Block[] = []
  const remainingBlocks = [...blocks]
  const prefixLength = renderLength(prefixBlocks, renderConfig)

  if (prefixLength > limit) {
    diagnostics.push(
      error(
        'CONTINUATION_PREAMBLE_TOO_LONG',
        `Continuation preamble renders to ${prefixLength} characters and exceeds the ${limit}-character limit.`,
      ),
    )
    return { chunkBlocks: [], remainingBlocks, diagnostics }
  }

  while (remainingBlocks.length > 0) {
    const nextUnit = takeLeadingSplitUnit(remainingBlocks, splitRules)
    const nextBlock = nextUnit.blocks[0]
    if (!nextBlock) {
      break
    }

    const candidateBlocks = [...prefixBlocks, ...contentBlocks, ...nextUnit.blocks]
    if (renderLength(candidateBlocks, renderConfig) <= limit) {
      contentBlocks.push(...nextUnit.blocks)
      remainingBlocks.splice(0, nextUnit.blockCount)
      continue
    }

    if (!splitRules.keepParagraphIntact && nextUnit.blockCount === 1 && nextBlock.type === 'paragraph') {
      const splitResult = splitBlockToFit(nextBlock, limit, [...prefixBlocks, ...contentBlocks], renderConfig)
      if (splitResult.head) {
        contentBlocks.push(splitResult.head)

        if (splitResult.tail) {
          remainingBlocks[0] = splitResult.tail
        } else {
          remainingBlocks.shift()
        }

        return {
          chunkBlocks: [...prefixBlocks, ...contentBlocks],
          remainingBlocks,
          diagnostics,
        }
      }
    }

    if (contentBlocks.length === 0) {
      const forcedChunk = takeChunkFromRawBlocks(nextUnit.blocks, limit, prefixBlocks, allowEmptyChunk, renderConfig)
      remainingBlocks.splice(0, nextUnit.blockCount, ...forcedChunk.remainingBlocks)
      return {
        chunkBlocks: forcedChunk.chunkBlocks,
        remainingBlocks,
        diagnostics: [...diagnostics, ...forcedChunk.diagnostics],
      }
    }

    break
  }

  return {
    chunkBlocks: [...prefixBlocks, ...contentBlocks],
    remainingBlocks,
    diagnostics,
  }
}

function takeChunkFromRawBlocks(
  blocks: Block[],
  limit: number,
  prefixBlocks: Block[],
  allowEmptyChunk: boolean,
  renderConfig?: PlanPostInput['renderConfig'],
): ChunkTakeResult {
  const diagnostics: Diagnostic[] = []
  const contentBlocks: Block[] = []
  const remainingBlocks = [...blocks]

  while (remainingBlocks.length > 0) {
    const nextBlock = remainingBlocks[0]
    if (!nextBlock) {
      break
    }

    const candidateBlocks = [...prefixBlocks, ...contentBlocks, nextBlock]
    if (renderLength(candidateBlocks, renderConfig) <= limit) {
      contentBlocks.push(nextBlock)
      remainingBlocks.shift()
      continue
    }

    if (contentBlocks.length === 0) {
      const splitResult = splitBlockToFit(nextBlock, limit, prefixBlocks, renderConfig)
      if (splitResult.head) {
        contentBlocks.push(splitResult.head)

        if (splitResult.tail) {
          remainingBlocks[0] = splitResult.tail
        } else {
          remainingBlocks.shift()
        }

        return {
          chunkBlocks: [...prefixBlocks, ...contentBlocks],
          remainingBlocks,
          diagnostics,
        }
      }

      if (allowEmptyChunk) {
        return {
          chunkBlocks: [],
          remainingBlocks,
          diagnostics,
        }
      }

      diagnostics.push(
        error(
          'UNSPLITTABLE_BLOCK_OVERFLOW',
          `A ${nextBlock.type} block exceeds the ${limit}-character limit and cannot be split automatically.`,
        ),
      )

      return { chunkBlocks: [], remainingBlocks, diagnostics }
    }

    break
  }

  return {
    chunkBlocks: [...prefixBlocks, ...contentBlocks],
    remainingBlocks,
    diagnostics,
  }
}

function splitBlockToFit(
  block: Block,
  limit: number,
  prefixBlocks: Block[],
  renderConfig?: PlanPostInput['renderConfig'],
): BlockSplitResult {
  switch (block.type) {
    case 'paragraph':
      return splitInlineBlockToFit(
        block,
        block.content,
        limit,
        prefixBlocks,
        content => ({
          type: 'paragraph',
          content,
        }),
        renderConfig,
      )
    case 'heading':
      return splitInlineBlockToFit(
        block,
        block.content,
        limit,
        prefixBlocks,
        content => ({
          type: 'heading',
          level: block.level,
          content,
        }),
        renderConfig,
      )
    default:
      return {}
  }
}

function splitInlineBlockToFit(
  _block: Block,
  inline: Inline[],
  limit: number,
  prefixBlocks: Block[],
  buildBlock: (content: Inline[]) => Block,
  renderConfig?: PlanPostInput['renderConfig'],
): BlockSplitResult {
  const segments = flattenInline(inline)
  const acceptedSegments: InlineSegment[] = []
  const remainingSegments = [...segments]

  while (remainingSegments.length > 0) {
    const nextSegment = remainingSegments[0]
    if (!nextSegment) {
      break
    }

    const candidateSegments = [...acceptedSegments, nextSegment]
    if (renderLength([...prefixBlocks, buildBlock(rebuildInline(candidateSegments))], renderConfig) <= limit) {
      acceptedSegments.push(nextSegment)
      remainingSegments.shift()
      continue
    }

    if (acceptedSegments.length === 0 && nextSegment.type === 'text') {
      const partialSplit = splitTextSegmentToFit(
        nextSegment,
        acceptedSegments,
        limit,
        prefixBlocks,
        buildBlock,
        renderConfig,
      )
      if (!partialSplit.accepted) {
        return {}
      }

      acceptedSegments.push(partialSplit.accepted)
      if (partialSplit.remainder) {
        remainingSegments[0] = partialSplit.remainder
      } else {
        remainingSegments.shift()
      }
      break
    }

    break
  }

  if (acceptedSegments.length === 0) {
    return {}
  }

  const head = buildBlock(rebuildInline(acceptedSegments))
  const tailInline = rebuildInline(remainingSegments)

  if (tailInline.length === 0) {
    return { head }
  }

  return {
    head,
    tail: buildBlock(tailInline),
  }
}

function splitTextSegmentToFit(
  segment: Extract<InlineSegment, { type: 'text' }>,
  acceptedSegments: InlineSegment[],
  limit: number,
  prefixBlocks: Block[],
  buildBlock: (content: Inline[]) => Block,
  renderConfig?: PlanPostInput['renderConfig'],
): { accepted?: Extract<InlineSegment, { type: 'text' }>; remainder?: Extract<InlineSegment, { type: 'text' }> } {
  const tokenizedParts = segment.value.split(/(\s+)/).filter(part => part.length > 0)
  let acceptedValue = ''
  let consumedLength = 0

  for (const part of tokenizedParts) {
    const candidateValue = acceptedValue + part
    const candidateSegment = { ...segment, value: candidateValue }
    if (
      renderLength(
        [...prefixBlocks, buildBlock(rebuildInline([...acceptedSegments, candidateSegment]))],
        renderConfig,
      ) <= limit
    ) {
      acceptedValue = candidateValue
      consumedLength += part.length
      continue
    }

    break
  }

  if (acceptedValue.length === 0) {
    let low = 1
    let high = segment.value.length
    let best = 0

    while (low <= high) {
      const middle = Math.floor((low + high) / 2)
      const candidateSegment = { ...segment, value: segment.value.slice(0, middle) }
      if (
        renderLength(
          [...prefixBlocks, buildBlock(rebuildInline([...acceptedSegments, candidateSegment]))],
          renderConfig,
        ) <= limit
      ) {
        best = middle
        low = middle + 1
      } else {
        high = middle - 1
      }
    }

    if (best === 0) {
      return {}
    }

    acceptedValue = segment.value.slice(0, best)
    consumedLength = best
  }

  const trimmedAccepted = acceptedValue.replace(/\s+$/u, '')
  const rawRemainder = segment.value.slice(consumedLength)
  const trimmedRemainder = rawRemainder.replace(/^\s+/u, '')

  if (trimmedAccepted.length === 0) {
    return {}
  }

  return {
    accepted: {
      ...segment,
      value: trimmedAccepted,
    },
    remainder:
      trimmedRemainder.length > 0
        ? {
            ...segment,
            value: trimmedRemainder,
          }
        : undefined,
  }
}

function flattenInline(inline: Inline[], wrappers: InlineWrapper[] = []): InlineSegment[] {
  const segments: InlineSegment[] = []

  for (const token of inline) {
    switch (token.type) {
      case 'text':
        segments.push({ type: 'text', value: token.value, wrappers })
        break
      case 'code':
        segments.push({ type: 'code', value: token.value, wrappers })
        break
      case 'break':
        segments.push({ type: 'break', wrappers })
        break
      case 'bold':
        segments.push(...flattenInline(token.children, [...wrappers, { type: 'bold' }]))
        break
      case 'italic':
        segments.push(...flattenInline(token.children, [...wrappers, { type: 'italic' }]))
        break
      case 'strike':
        segments.push(...flattenInline(token.children, [...wrappers, { type: 'strike' }]))
        break
      case 'link':
        segments.push(...flattenInline(token.children, [...wrappers, { type: 'link', href: token.href }]))
        break
    }
  }

  return segments
}

function rebuildInline(segments: InlineSegment[]): Inline[] {
  const root: Inline[] = []
  const stack: Array<{ wrapper: InlineWrapper; children: Inline[] }> = []

  for (const segment of segments) {
    const commonPrefixLength = getCommonPrefixLength(
      stack.map(entry => entry.wrapper),
      segment.wrappers,
    )

    stack.length = commonPrefixLength
    let target = stack.length > 0 ? (stack[stack.length - 1]?.children ?? root) : root

    for (let index = commonPrefixLength; index < segment.wrappers.length; index += 1) {
      const wrapper = segment.wrappers[index]
      if (!wrapper) {
        continue
      }

      const children: Inline[] = []
      target.push(createWrapperInline(wrapper, children))
      stack.push({ wrapper, children })
      target = children
    }

    target = stack.length > 0 ? (stack[stack.length - 1]?.children ?? root) : root
    target.push(createLeafInline(segment))
  }

  return root
}

function getCommonPrefixLength(left: InlineWrapper[], right: InlineWrapper[]): number {
  const max = Math.min(left.length, right.length)
  let index = 0

  while (index < max) {
    const leftWrapper = left[index]
    const rightWrapper = right[index]

    if (!leftWrapper || !rightWrapper) {
      break
    }

    if (leftWrapper.type !== rightWrapper.type || leftWrapper.href !== rightWrapper.href) {
      break
    }

    index += 1
  }

  return index
}

function createWrapperInline(wrapper: InlineWrapper, children: Inline[]): Inline {
  switch (wrapper.type) {
    case 'bold':
      return { type: 'bold', children }
    case 'italic':
      return { type: 'italic', children }
    case 'strike':
      return { type: 'strike', children }
    case 'link':
      return { type: 'link', href: wrapper.href ?? '#', children }
  }
}

function createLeafInline(segment: InlineSegment): Inline {
  switch (segment.type) {
    case 'text':
      return { type: 'text', value: segment.value }
    case 'code':
      return { type: 'code', value: segment.value }
    case 'break':
      return { type: 'break' }
  }
}

function renderBlocks(blocks: Block[], renderConfig?: PlanPostInput['renderConfig']): string {
  return renderBotHtml(blocks, renderConfig).bodyHtml
}

function renderLength(blocks: Block[], renderConfig?: PlanPostInput['renderConfig']): number {
  if (blocks.length === 0) {
    return 0
  }

  return renderBlocks(blocks, renderConfig).length
}

interface NormalizedSplitRules {
  keepParagraphIntact: boolean
  keepHeadingWithNextBlock: boolean
  keepColonPreambleWithList: boolean
  keepColonPreambleWithQuote: boolean
}

function normalizeSplitRules(config?: SplitRulesConfig): NormalizedSplitRules {
  return {
    keepParagraphIntact: config?.keepParagraphIntact ?? true,
    keepHeadingWithNextBlock: config?.keepHeadingWithNextBlock ?? false,
    keepColonPreambleWithList: config?.keepColonPreambleWithList ?? false,
    keepColonPreambleWithQuote: config?.keepColonPreambleWithQuote ?? false,
  }
}

function takeLeadingSplitUnit(blocks: Block[], splitRules: NormalizedSplitRules): SplitUnit {
  const firstBlock = blocks[0]
  if (!firstBlock) {
    return { blocks: [], blockCount: 0 }
  }

  const unitBlocks = [firstBlock]
  let blockCount = 1

  while (blockCount < blocks.length) {
    const lastBlock = unitBlocks[unitBlocks.length - 1]
    const nextBlock = blocks[blockCount]
    if (!lastBlock || !nextBlock) {
      break
    }

    if (splitRules.keepHeadingWithNextBlock && lastBlock.type === 'heading') {
      unitBlocks.push(nextBlock)
      blockCount += 1
      continue
    }

    if (lastBlock.type === 'paragraph' && endsWithColon(lastBlock.content)) {
      if (splitRules.keepColonPreambleWithList && nextBlock.type === 'list') {
        unitBlocks.push(nextBlock)
        blockCount += 1
        continue
      }

      if (splitRules.keepColonPreambleWithQuote && nextBlock.type === 'blockquote') {
        unitBlocks.push(nextBlock)
        blockCount += 1
        continue
      }
    }

    break
  }

  return {
    blocks: unitBlocks,
    blockCount,
  }
}

function endsWithColon(inline: Inline[]): boolean {
  return extractInlineText(inline).trimEnd().endsWith(':')
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
