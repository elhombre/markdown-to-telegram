export type MediaPosition = 'none' | 'media-first' | 'text-first'

export type MediaItem =
  | { kind: 'local-file'; path: string; alt?: string }
  | { kind: 'remote-url'; url: string; alt?: string }
  | { kind: 'telegram-file-id'; fileId: string; alt?: string }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: Inline[] }
  | { type: 'paragraph'; content: Inline[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'blockquote'; blocks: Block[] }
  | { type: 'code'; language?: string; content: string }
  | { type: 'rule' }

export interface ListItem {
  blocks: Block[]
}

export type Inline =
  | { type: 'text'; value: string }
  | { type: 'bold'; children: Inline[] }
  | { type: 'italic'; children: Inline[] }
  | { type: 'strike'; children: Inline[] }
  | { type: 'code'; value: string }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'break' }

export interface AttachmentItem {
  path: string
  label: string
  extension: string
}

export interface AttachmentConfig {
  sectionTitle?: string
  allowedExtensions?: string[]
}

export interface HeadingDecorationConfig {
  prefix?: string
  suffix?: string
}

export interface HeadingDecorationsConfig {
  h1?: HeadingDecorationConfig
  h2?: HeadingDecorationConfig
  h3?: HeadingDecorationConfig
}

export type HeadingTextStyle = 'bold' | 'italic' | 'underline' | 'strike' | 'code'

export interface HeadingStylesConfig {
  h3?: HeadingTextStyle[]
}

export interface SectionHeadingRuleConfig {
  pattern: string
  prefix?: string
  suffix?: string
  replaceText?: string
}

export interface SplitRulesConfig {
  keepParagraphIntact?: boolean
  keepHeadingWithNextBlock?: boolean
  keepColonPreambleWithList?: boolean
  keepColonPreambleWithQuote?: boolean
}

export interface BotHtmlRenderConfig {
  headingDecorations?: HeadingDecorationsConfig
  headingStyles?: HeadingStylesConfig
  sectionHeadingRules?: SectionHeadingRuleConfig[]
}

export interface PostDocument {
  mediaPosition: MediaPosition
  media: MediaItem[]
  blocks: Block[]
  attachments: AttachmentItem[]
}

export interface RenderedHtml {
  format: 'bot-html'
  bodyHtml: string
}

export interface Diagnostic {
  level: 'error' | 'warning'
  code: string
  message: string
}

export type PublishTarget = 'bot-api' | 'tdlib'
export type OverflowMode = 'fail' | 'split'

export interface PublishCapabilities {
  target: PublishTarget
  messageLimit: number
  captionLimit: number
  mediaGroupMinItems: number
  mediaGroupMaxItems: number
  supportsReply: boolean
}

export type PublishStep =
  | { type: 'send-message'; html: string }
  | { type: 'send-photo'; media: MediaItem; caption?: string }
  | { type: 'send-media-group'; media: MediaItem[]; caption?: string }
  | { type: 'send-document'; attachment: AttachmentItem; caption?: string }

export interface PublishPlan {
  target: PublishTarget
  steps: PublishStep[]
  diagnostics: Diagnostic[]
}

export interface PreparePostInput {
  markdown: string
  baseDir?: string
  attachmentConfig?: AttachmentConfig
  renderConfig?: BotHtmlRenderConfig
}

export interface PreparePostResult {
  document: PostDocument
  renderedHtml: RenderedHtml
  diagnostics: Diagnostic[]
}

export interface PlanPostInput {
  document: PostDocument
  renderedHtml: RenderedHtml
  capabilities: PublishCapabilities
  overflowMode?: OverflowMode
  continuationBlocks?: Block[]
  renderConfig?: BotHtmlRenderConfig
  splitRules?: SplitRulesConfig
}
