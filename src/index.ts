import { publishBotApiPlan, type BotApiPublishConfig, type PublishResult as BotApiPublishResult } from './transport-bot-api/index.js'
import {
  type AttachmentConfig,
  type Block,
  type BotHtmlRenderConfig,
  type Diagnostic,
  type OverflowMode,
  type PublishCapabilities,
  type PublishPlan,
  type PublishTarget,
  type RenderedHtml,
  type SplitRulesConfig,
  planPost,
  preparePost,
} from './core/index.js'
import { publishTdlibPlan, resolveTdlibCapabilities } from './transport-tdlib/index.js'
import type { TdlibCapabilityConfig, TdlibPublishConfig, TdlibPublishResult } from './transport-tdlib/types.js'

export * from './core/index.js'
export * from './transport-bot-api/index.js'
export * from './transport-tdlib/index.js'
export * from './pdf-thumbnail/index.js'

export interface PrepareMarkdownToTelegramInput {
  markdown: string
  baseDir?: string
  attachmentConfig?: AttachmentConfig
  renderConfig?: BotHtmlRenderConfig
  plan?: {
    capabilities: PublishCapabilities
    overflowMode?: OverflowMode
    continuationMarkdown?: string
    splitRules?: SplitRulesConfig
  }
}

export interface PrepareMarkdownToTelegramResult {
  document: ReturnType<typeof preparePost>['document']
  renderedHtml: RenderedHtml
  plan?: PublishPlan
  diagnostics: Diagnostic[]
}

export type PublishMarkdownToTelegramResult =
  | { target: 'bot-api'; prepared: PrepareMarkdownToTelegramResult; publish: BotApiPublishResult }
  | { target: 'tdlib'; prepared: PrepareMarkdownToTelegramResult; publish: TdlibPublishResult }

export type PublishMarkdownToTelegramInput =
  | {
      target: 'bot-api'
      markdown: string
      baseDir?: string
      attachmentConfig?: AttachmentConfig
      renderConfig?: BotHtmlRenderConfig
      overflowMode?: OverflowMode
      continuationMarkdown?: string
      splitRules?: SplitRulesConfig
      capabilities?: PublishCapabilities
      publish: BotApiPublishConfig
    }
  | {
      target: 'tdlib'
      markdown: string
      baseDir?: string
      attachmentConfig?: AttachmentConfig
      renderConfig?: BotHtmlRenderConfig
      overflowMode?: OverflowMode
      continuationMarkdown?: string
      splitRules?: SplitRulesConfig
      capabilities?: PublishCapabilities
      capabilityConfig?: TdlibCapabilityConfig
      publish: TdlibPublishConfig
    }

export function prepareMarkdownToTelegram(input: PrepareMarkdownToTelegramInput): PrepareMarkdownToTelegramResult {
  const prepared = preparePost({
    markdown: input.markdown,
    baseDir: input.baseDir,
    attachmentConfig: input.attachmentConfig,
    renderConfig: input.renderConfig,
  })
  const diagnostics = [...prepared.diagnostics]

  if (!input.plan) {
    return {
      ...prepared,
      diagnostics,
    }
  }

  const continuationBlocks = input.plan.continuationMarkdown
    ? parseContinuationMarkdown(input.plan.continuationMarkdown, input.baseDir, input.renderConfig)
    : []

  const plan = planPost({
    document: prepared.document,
    renderedHtml: prepared.renderedHtml,
    capabilities: input.plan.capabilities,
    overflowMode: input.plan.overflowMode,
    continuationBlocks,
    renderConfig: input.renderConfig,
    splitRules: input.plan.splitRules,
  })

  diagnostics.push(...plan.diagnostics)

  return {
    ...prepared,
    plan,
    diagnostics,
  }
}

export async function publishMarkdownToTelegram(
  input: PublishMarkdownToTelegramInput,
): Promise<PublishMarkdownToTelegramResult> {
  const capabilities = await resolvePublishCapabilities(input)
  const prepared = prepareMarkdownToTelegram({
    markdown: input.markdown,
    baseDir: input.baseDir,
    attachmentConfig: input.attachmentConfig,
    renderConfig: input.renderConfig,
    plan: {
      capabilities,
      overflowMode: input.overflowMode,
      continuationMarkdown: input.continuationMarkdown,
      splitRules: input.splitRules,
    },
  })

  throwIfDiagnosticsHaveErrors(prepared.diagnostics)

  if (!prepared.plan) {
    throw new Error('Failed to build a publish plan.')
  }

  if (input.target === 'bot-api') {
    return {
      target: 'bot-api',
      prepared,
      publish: await publishBotApiPlan(prepared.plan, input.publish),
    }
  }

  return {
    target: 'tdlib',
    prepared,
    publish: await publishTdlibPlan(prepared.plan, input.publish),
  }
}

function parseContinuationMarkdown(
  markdown: string,
  baseDir: string | undefined,
  renderConfig: BotHtmlRenderConfig | undefined,
): Block[] {
  const continuation = preparePost({
    markdown,
    baseDir,
    renderConfig,
  })

  throwIfDiagnosticsHaveErrors(continuation.diagnostics)

  if (continuation.document.media.length > 0) {
    throw new Error('Continuation Markdown must not contain media.')
  }

  return continuation.document.blocks
}

async function resolvePublishCapabilities(input: PublishMarkdownToTelegramInput): Promise<PublishCapabilities> {
  if (input.capabilities) {
    return assertCapabilitiesTarget(input.capabilities, input.target)
  }

  if (input.target === 'bot-api') {
    return {
      target: 'bot-api',
      messageLimit: 4096,
      captionLimit: 1024,
      mediaGroupMinItems: 2,
      mediaGroupMaxItems: 10,
      supportsReply: true,
    }
  }

  const resolution = await resolveTdlibCapabilities(input.capabilityConfig ?? input.publish)
  return resolution.capabilities
}

function assertCapabilitiesTarget(capabilities: PublishCapabilities, target: PublishTarget): PublishCapabilities {
  if (capabilities.target !== target) {
    throw new Error(`Capabilities target "${capabilities.target}" does not match publish target "${target}".`)
  }

  return capabilities
}

function throwIfDiagnosticsHaveErrors(diagnostics: Diagnostic[]): void {
  const errors = diagnostics.filter(diagnostic => diagnostic.level === 'error')

  if (errors.length > 0) {
    throw new Error(errors.map(error => `[${error.code}] ${error.message}`).join('\n'))
  }
}
