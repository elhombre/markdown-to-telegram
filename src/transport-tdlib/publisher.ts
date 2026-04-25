import type { AttachmentItem, MediaItem, PublishPlan, PublishStep } from '../core/index.js'
import { withPublishGuard } from './publish-guard.js'

import { resolveCapabilitiesFromRuntime } from './capabilities.js'
import {
  TdlibMessageSendError,
  closeTdlibClient,
  createLocalInputFile,
  createLoggedInTdlibClient,
  deleteMessages,
  getFileName,
  getRuntimeSnapshot,
  maybeCreateDocumentThumbnail,
  parseHtmlToFormattedText,
  resolveChat,
  sendDocumentMessage,
  sendPhotoAlbum,
  sendPhotoMessage,
  sendTextMessage,
} from './client.js'
import type { TdlibPublishConfig, TdlibPublishResult } from './types.js'

const DEFAULT_SEND_RETRIES = 1
const ROLLBACK_DELETE_RETRIES = 3

export async function publishTdlibPlan(plan: PublishPlan, config: TdlibPublishConfig): Promise<TdlibPublishResult> {
  if (plan.target !== 'tdlib') {
    throw new Error(`Cannot publish target "${plan.target}" with the TDLib publisher.`)
  }

  validatePlanSupport(plan)

  return withPublishGuard(
    {
      scopeKey: `tdlib::${config.chatId}`,
      minPostIntervalMs: config.minPostIntervalMs,
      stateFile: config.postStateFile,
      lockFile: config.postLockFile,
    },
    async () => {
      const client = await createLoggedInTdlibClient(config)

      try {
        const capabilityResolution = resolveCapabilitiesFromRuntime(
          config.accountTier ?? 'auto',
          await getRuntimeSnapshot(client),
        )
        const chat = await resolveChat(client, config.chatId)
        const messageIds: number[] = []
        const sendRetries = normalizeRetryCount(config.sendRetries)

        for (const [index, step] of plan.steps.entries()) {
          try {
            const published = await publishStepWithRetries(client, chat.id, step, config, sendRetries)
            messageIds.push(...published)
          } catch (error: unknown) {
            await rollbackMessages(client, chat.id, messageIds)
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to publish TDLib step ${index + 1}/${plan.steps.length}: ${message}`)
          }
        }

        return {
          target: 'tdlib',
          messageIds,
          resolvedChatId: chat.id,
          resolvedChatTitle: chat.title,
          accountTierResolved: capabilityResolution.accountTierResolved,
          warnings: capabilityResolution.warnings,
        }
      } finally {
        await closeTdlibClient(client)
      }
    },
  )
}

async function publishStepWithRetries(
  client: Awaited<ReturnType<typeof createLoggedInTdlibClient>>,
  chatId: number,
  step: PublishStep,
  config: TdlibPublishConfig,
  sendRetries: number,
): Promise<number[]> {
  let lastError: unknown

  for (let attempt = 1; attempt <= sendRetries; attempt += 1) {
    try {
      return await publishStep(client, chatId, step, config)
    } catch (error: unknown) {
      const pendingMessageIds = extractPendingMessageIds(error)
      if (pendingMessageIds.length > 0) {
        await rollbackMessages(client, chatId, pendingMessageIds)
      }
      lastError = error
    }
  }

  throw lastError
}

async function publishStep(
  client: Awaited<ReturnType<typeof createLoggedInTdlibClient>>,
  chatId: number,
  step: PublishStep,
  config: TdlibPublishConfig,
): Promise<number[]> {
  switch (step.type) {
    case 'send-message': {
      const formatted = await parseHtmlToFormattedText(client, step.html)
      return [
        await sendTextMessage(client, {
          chatId,
          formattedText: formatted,
          disableWebPagePreview: config.disableWebPagePreview ?? false,
        }),
      ]
    }
    case 'send-photo': {
      const formatted = await parseHtmlToFormattedText(client, step.caption ?? '')
      return [
        await sendPhotoMessage(client, {
          chatId,
          file: createLocalInputFile(getLocalMediaPath(step.media)),
          caption: formatted,
        }),
      ]
    }
    case 'send-media-group': {
      const caption = step.caption ? await parseHtmlToFormattedText(client, step.caption) : undefined
      return sendPhotoAlbum(client, {
        chatId,
        files: step.media.map(media => createLocalInputFile(getLocalMediaPath(media))),
        caption,
      })
    }
    case 'send-document': {
      const formatted = await parseHtmlToFormattedText(client, step.caption ?? '')
      const thumbnail = await maybeCreateDocumentThumbnail(step.attachment.path, {
        generate: config.generateDocumentThumbnails ?? false,
        saveGeneratedThumbnail: config.saveGeneratedThumbnails ?? false,
      })

      return [
        await sendDocumentMessage(client, {
          chatId,
          file: createLocalInputFile(step.attachment.path),
          fileName: getFileName(step.attachment.path),
          caption: formatted,
          thumbnail,
        }),
      ]
    }
  }
}

async function rollbackMessages(
  client: Awaited<ReturnType<typeof createLoggedInTdlibClient>>,
  chatId: number,
  messageIds: number[],
): Promise<void> {
  const pendingIds = [...messageIds]

  for (let attempt = 0; attempt < ROLLBACK_DELETE_RETRIES; attempt += 1) {
    if (pendingIds.length === 0) {
      return
    }

    try {
      await deleteMessages(client, chatId, pendingIds)
      pendingIds.length = 0
      return
    } catch {
      // Keep retrying with the same set.
    }
  }
}

function validatePlanSupport(plan: PublishPlan): void {
  for (const step of plan.steps) {
    switch (step.type) {
      case 'send-photo':
        assertLocalMedia(step.media)
        break
      case 'send-media-group':
        for (const media of step.media) {
          assertLocalMedia(media)
        }
        break
      case 'send-document':
      case 'send-message':
        break
    }
  }
}

function assertLocalMedia(media: MediaItem): void {
  if (media.kind === 'local-file') {
    return
  }

  if (media.kind === 'remote-url') {
    throw new Error('TDLib publishing currently supports only local media files; remote-url media is not supported.')
  }

  throw new Error(
    'TDLib publishing currently does not support telegram-file-id media because Bot API file identifiers are not guaranteed to be valid TDLib remote file identifiers.',
  )
}

function getLocalMediaPath(media: MediaItem): string {
  assertLocalMedia(media)
  return (media as Extract<MediaItem, { kind: 'local-file' }>).path
}

function normalizeRetryCount(sendRetries?: number): number {
  if (sendRetries === undefined) {
    return DEFAULT_SEND_RETRIES
  }

  if (!Number.isInteger(sendRetries) || sendRetries < 1) {
    throw new Error('Invalid TDLib sendRetries value. Expected an integer greater than or equal to 1.')
  }

  return sendRetries
}

function extractPendingMessageIds(error: unknown): number[] {
  return error instanceof TdlibMessageSendError ? error.pendingMessageIds : []
}
