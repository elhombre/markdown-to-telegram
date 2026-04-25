import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, parse } from 'node:path'

import type { AttachmentItem, MediaItem, PublishPlan, PublishStep } from '../core/index.js'
import { generatePdfThumbnail } from '../pdf-thumbnail/index.js'
import { withPublishGuard } from './publish-guard.js'

const TELEGRAM_API_BASE = 'https://api.telegram.org'
const DEFAULT_SEND_RETRIES = 1
const ROLLBACK_DELETE_RETRIES = 3
const DELETE_MESSAGES_BATCH_LIMIT = 100

interface TelegramChat {
  id: number
  title?: string
  username?: string
  type: string
}

interface TelegramMessage {
  message_id: number
  chat: TelegramChat
}

interface TelegramApiResponse<T> {
  ok: boolean
  description?: string
  result?: T
}

export interface BotApiPublishConfig {
  token: string
  chatId: string
  disableWebPagePreview?: boolean
  generateDocumentThumbnails?: boolean
  saveGeneratedThumbnails?: boolean
  sendRetries?: number
  minPostIntervalMs?: number
  postStateFile?: string
  postLockFile?: string
}

export interface PublishRollbackResult {
  attemptedMessageIds: number[]
  deletedMessageIds: number[]
  remainingMessageIds: number[]
  attempts: number
}

export class BotApiPublishError extends Error {
  readonly failedStepIndex: number
  readonly attempts: number
  readonly publishedMessageIds: number[]
  readonly rollback: PublishRollbackResult

  constructor(options: {
    message: string
    failedStepIndex: number
    attempts: number
    publishedMessageIds: number[]
    rollback: PublishRollbackResult
    cause?: unknown
  }) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BotApiPublishError'
    this.failedStepIndex = options.failedStepIndex
    this.attempts = options.attempts
    this.publishedMessageIds = options.publishedMessageIds
    this.rollback = options.rollback
  }
}

export interface PublishResult {
  target: 'bot-api'
  messageIds: number[]
  messages: TelegramMessage[]
}

export async function publishBotApiPlan(plan: PublishPlan, config: BotApiPublishConfig): Promise<PublishResult> {
  if (plan.target !== 'bot-api') {
    throw new Error(`Cannot publish target "${plan.target}" with the Bot API publisher.`)
  }

  return withPublishGuard(
    {
      scopeKey: `bot-api::${config.chatId}`,
      minPostIntervalMs: config.minPostIntervalMs,
      stateFile: config.postStateFile,
      lockFile: config.postLockFile,
    },
    async () => {
      const messages: TelegramMessage[] = []
      const sendRetries = normalizeRetryCount(config.sendRetries)

      for (const [index, step] of plan.steps.entries()) {
        try {
          const result = await publishStepWithRetries(step, config, sendRetries)
          messages.push(...result)
        } catch (error: unknown) {
          const rollback = await rollbackPublishedMessages(config, messages)
          const detail =
            rollback.remainingMessageIds.length === 0 ? 'Rollback completed.' : 'Rollback left undeleted messages.'
          throw new BotApiPublishError({
            message: `Failed to publish step ${index + 1}/${plan.steps.length} after ${sendRetries} attempt(s). ${detail}`,
            failedStepIndex: index,
            attempts: sendRetries,
            publishedMessageIds: messages.map(message => message.message_id),
            rollback,
            cause: error,
          })
        }
      }

      return {
        target: 'bot-api',
        messageIds: messages.map(message => message.message_id),
        messages,
      }
    },
  )
}

async function publishStepWithRetries(
  step: PublishStep,
  config: BotApiPublishConfig,
  sendRetries: number,
): Promise<TelegramMessage[]> {
  let lastError: unknown

  for (let attempt = 1; attempt <= sendRetries; attempt += 1) {
    try {
      return await publishStep(step, config)
    } catch (error: unknown) {
      lastError = error
    }
  }

  throw lastError
}

async function publishStep(step: PublishStep, config: BotApiPublishConfig): Promise<TelegramMessage[]> {
  switch (step.type) {
    case 'send-message': {
      const payload = await callTelegramApi<TelegramMessage>(config.token, 'sendMessage', {
        chat_id: config.chatId,
        text: step.html,
        parse_mode: 'HTML',
        disable_web_page_preview: config.disableWebPagePreview ?? false,
      })
      return [payload]
    }
    case 'send-photo': {
      const form = new FormData()
      form.set('chat_id', config.chatId)
      form.set('parse_mode', 'HTML')
      if (step.caption) {
        form.set('caption', step.caption)
      }
      await appendSingleMedia(form, 'photo', step.media)
      const payload = await callTelegramApi<TelegramMessage>(config.token, 'sendPhoto', form)
      return [payload]
    }
    case 'send-media-group': {
      const form = new FormData()
      form.set('chat_id', config.chatId)
      const media = await buildMediaGroupPayload(step.media, step.caption)
      for (const attachment of media.attachments) {
        form.set(attachment.name, attachment.file)
      }
      form.set('media', JSON.stringify(media.items))
      const payload = await callTelegramApi<TelegramMessage[]>(config.token, 'sendMediaGroup', form)
      return payload
    }
    case 'send-document': {
      const form = new FormData()
      form.set('chat_id', config.chatId)
      form.set('parse_mode', 'HTML')
      if (step.caption) {
        form.set('caption', step.caption)
      }
      await appendDocument(form, 'document', step.attachment, config)
      const payload = await callTelegramApi<TelegramMessage>(config.token, 'sendDocument', form)
      return [payload]
    }
  }
}

async function rollbackPublishedMessages(
  config: BotApiPublishConfig,
  messages: TelegramMessage[],
): Promise<PublishRollbackResult> {
  const attemptedMessageIds = dedupeMessageIds(messages.map(message => message.message_id))
  let remainingMessageIds = attemptedMessageIds
  let attempts = 0

  while (remainingMessageIds.length > 0 && attempts < ROLLBACK_DELETE_RETRIES) {
    attempts += 1
    remainingMessageIds = await deleteMessageIds(config, remainingMessageIds)
  }

  const deletedMessageIds = attemptedMessageIds.filter(messageId => !remainingMessageIds.includes(messageId))

  return {
    attemptedMessageIds,
    deletedMessageIds,
    remainingMessageIds,
    attempts,
  }
}

async function deleteMessageIds(config: BotApiPublishConfig, messageIds: number[]): Promise<number[]> {
  let remaining = dedupeMessageIds(messageIds)

  for (const chunk of chunkMessageIds(remaining, DELETE_MESSAGES_BATCH_LIMIT)) {
    try {
      await callTelegramApi<boolean>(config.token, 'deleteMessages', {
        chat_id: config.chatId,
        message_ids: chunk,
      })
      remaining = remaining.filter(messageId => !chunk.includes(messageId))
    } catch {
      for (const messageId of chunk) {
        try {
          await callTelegramApi<boolean>(config.token, 'deleteMessage', {
            chat_id: config.chatId,
            message_id: messageId,
          })
          remaining = remaining.filter(candidate => candidate !== messageId)
        } catch {
          // Keep the message id in the remaining set for the next rollback attempt.
        }
      }
    }
  }

  return remaining
}

async function callTelegramApi<T>(token: string, method: string, body: FormData | Record<string, unknown>): Promise<T> {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
    method: 'POST',
    headers: body instanceof FormData ? undefined : { 'content-type': 'application/json' },
    body: body instanceof FormData ? body : JSON.stringify(body),
  })

  const payload = (await response.json()) as TelegramApiResponse<T>

  if (!response.ok || !payload.ok || payload.result === undefined) {
    throw new Error(payload.description ?? `Telegram API request failed with status ${response.status}.`)
  }

  return payload.result
}

async function appendSingleMedia(form: FormData, field: string, media: MediaItem): Promise<void> {
  if (media.kind === 'local-file') {
    const bytes = await readFile(media.path)
    form.set(field, new File([bytes], basename(media.path), { type: getMimeType(media.path) }))
    return
  }

  form.set(field, media.kind === 'remote-url' ? media.url : media.fileId)
}

async function appendDocument(
  form: FormData,
  field: string,
  attachment: AttachmentItem,
  config: BotApiPublishConfig,
): Promise<void> {
  const bytes = await readFile(attachment.path)
  form.set(field, new File([bytes], basename(attachment.path), { type: getMimeType(attachment.path) }))
  const thumbnail = await maybeGenerateDocumentThumbnail(attachment, config)
  if (thumbnail) {
    form.set('thumbnail', new File([Buffer.from(thumbnail.bytes)], thumbnail.filename, { type: 'image/jpeg' }))
  }
}

async function buildMediaGroupPayload(
  media: MediaItem[],
  caption?: string,
): Promise<{
  items: Array<Record<string, string>>
  attachments: Array<{ name: string; file: File }>
}> {
  const items: Array<Record<string, string>> = []
  const attachments: Array<{ name: string; file: File }> = []

  for (const [index, item] of media.entries()) {
    if (item.kind === 'local-file') {
      const attachmentName = `media${index}`
      const bytes = await readFile(item.path)
      attachments.push({
        name: attachmentName,
        file: new File([bytes], basename(item.path), { type: getMimeType(item.path) }),
      })
      items.push({
        type: 'photo',
        media: `attach://${attachmentName}`,
        ...(index === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
      })
      continue
    }

    items.push({
      type: 'photo',
      media: item.kind === 'remote-url' ? item.url : item.fileId,
      ...(index === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
    })
  }

  return { items, attachments }
}

function getMimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg'
    case '.png':
      return 'image/png'
    case '.webp':
      return 'image/webp'
    case '.gif':
      return 'image/gif'
    case '.pdf':
      return 'application/pdf'
    case '.zip':
      return 'application/zip'
    case '.doc':
      return 'application/msword'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    case '.txt':
      return 'text/plain'
    default:
      return 'application/octet-stream'
  }
}

async function maybeGenerateDocumentThumbnail(
  attachment: AttachmentItem,
  config: BotApiPublishConfig,
): Promise<Awaited<ReturnType<typeof generatePdfThumbnail>> | undefined> {
  if (!config.generateDocumentThumbnails || attachment.extension !== '.pdf') {
    return undefined
  }

  try {
    return await generatePdfThumbnail({
      pdfPath: attachment.path,
      outputPath: config.saveGeneratedThumbnails
        ? join(dirname(attachment.path), `${parse(attachment.path).name}.telegram-thumb.jpg`)
        : undefined,
    })
  } catch {
    return undefined
  }
}

function normalizeRetryCount(value?: number): number {
  if (value === undefined) {
    return DEFAULT_SEND_RETRIES
  }

  if (!Number.isInteger(value) || value < 1) {
    throw new Error('Bot API publish retry count must be an integer greater than or equal to 1.')
  }

  return value
}

function dedupeMessageIds(messageIds: number[]): number[] {
  return [...new Set(messageIds)]
}

function chunkMessageIds(messageIds: number[], size: number): number[][] {
  const chunks: number[][] = []

  for (let index = 0; index < messageIds.length; index += size) {
    chunks.push(messageIds.slice(index, index + size))
  }

  return chunks
}
