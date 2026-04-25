import type {
  Block,
  BotHtmlRenderConfig,
  HeadingDecorationConfig,
  HeadingTextStyle,
  Inline,
  RenderedHtml,
} from './types.js'

interface NormalizedSectionHeadingRule {
  pattern: RegExp
  prefix?: string
  suffix?: string
  replaceText?: string
}

interface NormalizedBotHtmlRenderConfig {
  headingDecorations: {
    h1?: { prefix?: string; suffix?: string }
    h2?: { prefix?: string; suffix?: string }
    h3?: { prefix?: string; suffix?: string }
  }
  headingStyles: {
    h3: HeadingTextStyle[]
  }
  sectionHeadingRules: NormalizedSectionHeadingRule[]
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function repeat(value: string, count: number): string {
  return new Array(count + 1).join(value)
}

function indentNestedBlock(value: string, depth: number): string {
  const indent = repeat('  ', depth)

  return value
    .split('\n')
    .map(line => `${indent}${line}`)
    .join('\n')
}

function normalizeSpacing(value: string): string {
  return value.replace(/\n{3,}/g, '\n\n').trim()
}

function renderInline(inline: Inline[]): string {
  return inline
    .map(token => {
      switch (token.type) {
        case 'text':
          return escapeHtml(token.value)
        case 'bold':
          return `<b>${renderInline(token.children)}</b>`
        case 'italic':
          return `<i>${renderInline(token.children)}</i>`
        case 'strike':
          return `<s>${renderInline(token.children)}</s>`
        case 'code':
          return `<code>${escapeHtml(token.value)}</code>`
        case 'link':
          return `<a href="${escapeHtml(token.href)}">${renderInline(token.children)}</a>`
        case 'break':
          return '\n'
      }

      return ''
    })
    .join('')
}

function applyHeadingStyles(value: string, styles: HeadingTextStyle[]): string {
  return styles.reduce((wrapped, style) => {
    switch (style) {
      case 'bold':
        return `<b>${wrapped}</b>`
      case 'italic':
        return `<i>${wrapped}</i>`
      case 'underline':
        return `<u>${wrapped}</u>`
      case 'strike':
        return `<s>${wrapped}</s>`
      case 'code':
        return `<code>${wrapped}</code>`
    }
  }, value)
}

function normalizeDecoration(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined
}

function applyHeadingDecorations(value: string, decoration?: { prefix?: string; suffix?: string }): string {
  return `${decoration?.prefix ?? ''}${value}${decoration?.suffix ?? ''}`
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

function normalizeSectionHeadingRules(config?: BotHtmlRenderConfig): NormalizedSectionHeadingRule[] {
  return (config?.sectionHeadingRules ?? []).map(rule => {
    try {
      return {
        pattern: new RegExp(rule.pattern),
        prefix: normalizeDecoration(rule.prefix),
        suffix: normalizeDecoration(rule.suffix),
        replaceText: rule.replaceText ?? undefined,
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid section heading rule regex "${rule.pattern}": ${message}`)
    }
  })
}

function normalizeRenderConfig(config?: BotHtmlRenderConfig): NormalizedBotHtmlRenderConfig {
  return {
    headingDecorations: {
      h1: normalizeHeadingDecoration(config?.headingDecorations?.h1),
      h2: normalizeHeadingDecoration(config?.headingDecorations?.h2),
      h3: normalizeHeadingDecoration(config?.headingDecorations?.h3),
    },
    headingStyles: {
      h3: normalizeHeadingStyles(config?.headingStyles?.h3, ['italic']),
    },
    sectionHeadingRules: normalizeSectionHeadingRules(config),
  }
}

function normalizeHeadingDecoration(decoration?: HeadingDecorationConfig): { prefix?: string; suffix?: string } | undefined {
  if (!decoration) {
    return undefined
  }

  const prefix = normalizeDecoration(decoration.prefix)
  const suffix = normalizeDecoration(decoration.suffix)

  if (prefix === undefined && suffix === undefined) {
    return undefined
  }

  return { prefix, suffix }
}

function normalizeHeadingStyles(
  styles: HeadingTextStyle[] | undefined,
  fallback: HeadingTextStyle[],
): HeadingTextStyle[] {
  if (!styles) {
    return fallback
  }

  return styles.map(style => style)
}

function resolveHeadingRender(
  block: Extract<Block, { type: 'heading' }>,
  config: NormalizedBotHtmlRenderConfig,
): string {
  const headingText = extractInlineText(block.content).trim()
  const matchedRule = config.sectionHeadingRules.find(rule => rule.pattern.test(headingText))
  const body = matchedRule?.replaceText ? escapeHtml(matchedRule.replaceText) : renderInline(block.content)
  const content = applyHeadingDecorations(
    body,
    matchedRule?.prefix !== undefined || matchedRule?.suffix !== undefined
      ? { prefix: matchedRule.prefix, suffix: matchedRule.suffix }
      : block.level === 1
        ? config.headingDecorations.h1
        : block.level === 2
          ? config.headingDecorations.h2
          : block.level === 3
            ? config.headingDecorations.h3
            : block.level >= 4
              ? { prefix: `${repeat('•', Math.max(1, block.level - 2))} ` }
              : undefined,
  )

  if (block.level === 1 || block.level === 2 || block.level >= 4) {
    return `<b>${content}</b>`
  }

  return applyHeadingStyles(content, config.headingStyles.h3)
}

function renderBlock(block: Block, config: NormalizedBotHtmlRenderConfig): string {
  switch (block.type) {
    case 'heading':
      return resolveHeadingRender(block, config)
    case 'paragraph':
      return renderInline(block.content)
    case 'blockquote':
      return `<blockquote>${block.blocks.map(child => renderBlock(child, config)).join('\n')}</blockquote>`
    case 'code': {
      const code = escapeHtml(block.content.replace(/\n$/, ''))
      if (block.language) {
        return `<pre><code class="language-${escapeHtml(block.language)}">${code}</code></pre>`
      }
      return `<pre>${code}</pre>`
    }
    case 'rule':
      return '────────'
    case 'list':
      return renderList(block, 0, config)
  }
}

function renderList(
  block: Extract<Block, { type: 'list' }>,
  depth: number,
  config: NormalizedBotHtmlRenderConfig,
): string {
  return block.items
    .map((item, index) => {
      const marker = block.ordered ? `${index + 1}. ` : '• '
      const indent = repeat('  ', depth)
      const [first, ...rest] = item.blocks
      const lead = first ? renderBlock(first, config) : ''
      const extra = rest.map(child => indentNestedBlock(renderBlock(child, config), depth + 1)).join('\n')
      const prefix = `${indent}${marker}${lead}`.trimEnd()
      return extra ? `${prefix}\n${extra}` : prefix
    })
    .join('\n')
}

export function renderBotHtml(blocks: Block[], config?: BotHtmlRenderConfig): RenderedHtml {
  const normalizedConfig = normalizeRenderConfig(config)
  return {
    format: 'bot-html',
    bodyHtml: normalizeSpacing(blocks.map(block => renderBlock(block, normalizedConfig)).join('\n\n')),
  }
}
