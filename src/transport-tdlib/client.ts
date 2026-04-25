import { mkdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, parse, resolve } from 'node:path'

import { generatePdfThumbnail } from '../pdf-thumbnail/index.js'
import * as tdl from 'tdl'

import type {
  TdlibChatSearchResult,
  TdlibPremiumLimit,
  TdlibResolvedChat,
  TdlibRuntimeSnapshot,
  TdlibSessionConfig,
} from './types.js'

const require = createRequire(import.meta.url)
const { getTdjson } = require('prebuilt-tdlib') as { getTdjson: () => string }

let isConfigured = false
const MESSAGE_SEND_TIMEOUT_MS = 5 * 60 * 1000
const AUTHORIZATION_STATE_CLOSED_ERROR = 'Received authorizationStateClosed'

type TdClient = ReturnType<typeof tdl.createClient>

interface TdBaseObject {
  _: string
}

interface TdError extends TdBaseObject {
  _: 'error'
  code: number
  message: string
}

interface TdBooleanOption extends TdBaseObject {
  _: 'optionValueBoolean'
  value: boolean
}

interface TdIntegerOption extends TdBaseObject {
  _: 'optionValueInteger'
  value: number | string
}

interface TdUsernames extends TdBaseObject {
  active_usernames?: string[]
  editable_username?: string
}

interface TdUser extends TdBaseObject {
  _: 'user'
  id: number
  first_name: string
  last_name?: string
  usernames?: TdUsernames
  is_premium?: boolean
}

interface TdChatType extends TdBaseObject {
  supergroup_id?: number
  is_channel?: boolean
}

interface TdChat extends TdBaseObject {
  _: 'chat'
  id: number
  title: string
  type: TdChatType
}

interface TdFormattedText extends TdBaseObject {
  _: 'formattedText'
  text: string
  entities: unknown[]
}

interface TdMessage extends TdBaseObject {
  _: 'message'
  id: number
  chat_id?: number
  sending_state?: TdMessageSendingState | null
}

interface TdMessageSendingState extends TdBaseObject {
  _: 'messageSendingStatePending' | 'messageSendingStateFailed'
}

interface TdUpdateMessageSendSucceeded extends TdBaseObject {
  _: 'updateMessageSendSucceeded'
  old_message_id: number
  message: TdMessage
}

interface TdUpdateMessageSendFailed extends TdBaseObject {
  _: 'updateMessageSendFailed'
  old_message_id: number
  message: TdMessage
  error: TdError
}

interface TdUpdateDeleteMessages extends TdBaseObject {
  _: 'updateDeleteMessages'
  chat_id: number
  message_ids: number[]
}

interface TdPremiumLimit extends TdBaseObject {
  _: 'premiumLimit'
  default_value: number
  premium_value: number
}

interface TdInputFileLocal extends TdBaseObject {
  _: 'inputFileLocal'
  path: string
}

interface TdInputThumbnail extends TdBaseObject {
  _: 'inputThumbnail'
  thumbnail: TdInputFileLocal
  width: number
  height: number
}

interface TdLinkPreviewOptions extends TdBaseObject {
  _: 'linkPreviewOptions'
  is_disabled: boolean
}

interface TdChats extends TdBaseObject {
  _: 'chats'
  total_count: number
  chat_ids: number[]
}

type TdInputFile = TdInputFileLocal

export type { TdClient, TdFormattedText, TdInputFile, TdInputThumbnail }

export class TdlibMessageSendError extends Error {
  readonly pendingMessageIds: number[]

  constructor(message: string, pendingMessageIds: number[], options?: { cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'TdlibMessageSendError'
    this.pendingMessageIds = pendingMessageIds
  }
}

export async function createTdlibClient(config: TdlibSessionConfig): Promise<TdClient> {
  ensureConfigured()

  const sessionRootDir = resolve(config.sessionRootDir ?? '.md2tg/tdlib')
  const sessionName = normalizeSessionName(config.sessionName)
  const databaseDir = resolve(sessionRootDir, sessionName, 'db')
  const filesDir = resolve(sessionRootDir, sessionName, 'files')

  await mkdir(databaseDir, { recursive: true })
  await mkdir(filesDir, { recursive: true })

  const client = tdl.createClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    databaseDirectory: databaseDir,
    filesDirectory: filesDir,
    databaseEncryptionKey: config.databaseEncryptionKey ?? '',
    tdlibParameters: {
      use_file_database: config.useFileDatabase ?? true,
      use_chat_info_database: config.useChatInfoDatabase ?? true,
      use_message_database: config.useMessageDatabase ?? true,
      use_secret_chats: config.useSecretChats ?? false,
      system_language_code: config.systemLanguageCode ?? 'en',
      device_model: config.deviceModel ?? 'md2tg-tdlib',
      system_version: process.version,
      application_version: config.applicationVersion ?? '0.1.0',
      api_id: config.apiId,
      api_hash: config.apiHash,
      database_directory: databaseDir,
      files_directory: filesDir,
      use_test_dc: false,
    },
  })

  client.on('error', (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`TDLib error: ${message}\n`)
  })

  return client
}

export async function loginWithTdlib(client: TdClient): Promise<void> {
  await client.login()
}

export async function createLoggedInTdlibClient(config: TdlibSessionConfig): Promise<TdClient> {
  let client = await createTdlibClient(config)

  try {
    await loginWithTdlib(client)
    return client
  } catch (error: unknown) {
    await closeTdlibClient(client)

    if (!isAuthorizationStateClosedError(error)) {
      throw error
    }
  }

  client = await createTdlibClient(config)

  try {
    await loginWithTdlib(client)
    return client
  } catch (error: unknown) {
    await closeTdlibClient(client)
    throw error
  }
}

export async function closeTdlibClient(client: TdClient): Promise<void> {
  await client.close()
}

export async function invoke<T>(client: TdClient, request: Record<string, unknown>): Promise<T> {
  const response = (await client.invoke(request)) as unknown

  if (isTdError(response)) {
    throw new Error(`TDLib error ${response.code}: ${response.message}`)
  }

  return response as T
}

export async function getRuntimeSnapshot(client: TdClient): Promise<TdlibRuntimeSnapshot> {
  const me = await getCurrentUser(client)
  const accountIsPremium = await getResolvedPremiumStatus(client, me)
  const messageLimit = await getRequiredIntegerOption(client, 'message_text_length_max')
  const currentCaptionLimit = await getRequiredIntegerOption(client, 'message_caption_length_max')
  const captionLimit = await getCaptionPremiumLimit(client)

  return {
    accountIsPremium,
    messageLimit,
    currentCaptionLimit,
    standardCaptionLimit: captionLimit?.defaultValue,
    premiumCaptionLimit: captionLimit?.premiumValue,
  }
}

export async function getCurrentUser(client: TdClient): Promise<TdUser> {
  return invoke<TdUser>(client, { _: 'getMe' })
}

export async function getResolvedPremiumStatus(client: TdClient, currentUser?: TdUser): Promise<boolean | undefined> {
  const optionValue = await getBooleanOption(client, 'is_premium')
  const userValue = currentUser?.is_premium

  if (optionValue === undefined) {
    return userValue
  }

  if (userValue === undefined) {
    return optionValue
  }

  if (optionValue === userValue) {
    return optionValue
  }

  return undefined
}

export async function getCaptionPremiumLimit(client: TdClient): Promise<TdlibPremiumLimit | undefined> {
  try {
    const limit = await invoke<TdPremiumLimit>(client, {
      _: 'getPremiumLimit',
      limit_type: {
        _: 'premiumLimitTypeCaptionLength',
      },
    })

    return {
      defaultValue: limit.default_value,
      premiumValue: limit.premium_value,
    }
  } catch {
    return undefined
  }
}

export async function resolveChat(client: TdClient, value: string): Promise<TdlibResolvedChat> {
  const chat = isNumericChatId(value)
    ? await invoke<TdChat>(client, {
        _: 'getChat',
        chat_id: Number(value),
      })
    : await invoke<TdChat>(client, {
        _: 'searchPublicChat',
        username: normalizeChannelUsername(value),
      })

  return {
    id: chat.id,
    title: chat.title,
  }
}

export async function searchChats(client: TdClient, query: string, limit = 20): Promise<TdlibChatSearchResult[]> {
  const normalizedQuery = query.trim()

  if (normalizedQuery.length === 0) {
    throw new Error('Missing TDLib chat search query.')
  }

  if (isNumericChatId(normalizedQuery)) {
    const chat = await resolveChat(client, normalizedQuery)
    return [{ ...chat, source: 'chat-id' }]
  }

  if (normalizedQuery.startsWith('@')) {
    const chat = await resolveChat(client, normalizedQuery)
    return [{ ...chat, source: 'public-username' }]
  }

  await loadKnownChats(client, Math.max(limit, 50))

  const results = new Map<number, TdlibChatSearchResult>()
  const knownChatIds = await collectKnownChatIds(client, normalizedQuery, limit)

  for (const chatId of knownChatIds) {
    const chat = await resolveChat(client, String(chatId))
    results.set(chat.id, {
      ...chat,
      source: 'known-chat-search',
    })
  }

  return [...results.values()]
}

export async function parseHtmlToFormattedText(client: TdClient, html: string): Promise<TdFormattedText> {
  if (html.length === 0) {
    return {
      _: 'formattedText',
      text: '',
      entities: [],
    }
  }

  return invoke<TdFormattedText>(client, {
    _: 'parseTextEntities',
    text: html,
    parse_mode: {
      _: 'textParseModeHTML',
    },
  })
}

export async function sendTextMessage(
  client: TdClient,
  params: {
    chatId: number
    formattedText: TdFormattedText
    disableWebPagePreview: boolean
  },
): Promise<number> {
  const message = await invoke<TdMessage>(client, {
    _: 'sendMessage',
    chat_id: params.chatId,
    topic_id: null,
    reply_to: null,
    options: null,
    reply_markup: null,
    input_message_content: {
      _: 'inputMessageText',
      text: params.formattedText,
      link_preview_options: createLinkPreviewOptions(params.disableWebPagePreview),
      clear_draft: false,
    },
  })

  return waitForMessageSendCompletion(client, message, params.chatId)
}

export async function sendPhotoMessage(
  client: TdClient,
  params: {
    chatId: number
    file: TdInputFile
    caption: TdFormattedText
  },
): Promise<number> {
  const message = await invoke<TdMessage>(client, {
    _: 'sendMessage',
    chat_id: params.chatId,
    topic_id: null,
    reply_to: null,
    options: null,
    reply_markup: null,
    input_message_content: {
      _: 'inputMessagePhoto',
      photo: params.file,
      thumbnail: null,
      added_sticker_file_ids: [],
      width: 0,
      height: 0,
      caption: params.caption,
      show_caption_above_media: false,
      self_destruct_type: null,
      has_spoiler: false,
    },
  })

  return waitForMessageSendCompletion(client, message, params.chatId)
}

export async function sendPhotoAlbum(
  client: TdClient,
  params: {
    chatId: number
    files: TdInputFile[]
    caption?: TdFormattedText
  },
): Promise<number[]> {
  const messages = await invoke<TdMessage[]>(client, {
    _: 'sendMessageAlbum',
    chat_id: params.chatId,
    message_thread_id: 0,
    reply_to: null,
    options: null,
    input_message_contents: params.files.map((file, index) => ({
      _: 'inputMessagePhoto',
      photo: file,
      thumbnail: null,
      added_sticker_file_ids: [],
      width: 0,
      height: 0,
      caption: index === 0 ? (params.caption ?? emptyFormattedText()) : emptyFormattedText(),
      show_caption_above_media: false,
      self_destruct_type: null,
      has_spoiler: false,
    })),
  })

  return waitForMessagesSendCompletion(client, messages, params.chatId)
}

export async function sendDocumentMessage(
  client: TdClient,
  params: {
    chatId: number
    file: TdInputFile
    fileName: string
    caption: TdFormattedText
    thumbnail?: TdInputThumbnail
  },
): Promise<number> {
  const message = await invoke<TdMessage>(client, {
    _: 'sendMessage',
    chat_id: params.chatId,
    topic_id: null,
    reply_to: null,
    options: null,
    reply_markup: null,
    input_message_content: {
      _: 'inputMessageDocument',
      document: params.file,
      thumbnail: params.thumbnail ?? null,
      disable_content_type_detection: false,
      caption: params.caption,
    },
  })

  return waitForMessageSendCompletion(client, message, params.chatId)
}

export async function deleteMessages(client: TdClient, chatId: number, messageIds: number[]): Promise<void> {
  if (messageIds.length === 0) {
    return
  }

  await invoke<boolean>(client, {
    _: 'deleteMessages',
    chat_id: chatId,
    message_ids: messageIds,
    revoke: true,
  })
}

export function createLocalInputFile(path: string): TdInputFile {
  return {
    _: 'inputFileLocal',
    path,
  }
}

export async function maybeCreateDocumentThumbnail(
  path: string,
  options: {
    generate: boolean
    saveGeneratedThumbnail: boolean
  },
): Promise<TdInputThumbnail | undefined> {
  if (!options.generate || extname(path).toLowerCase() !== '.pdf') {
    return undefined
  }

  const thumbnailPath = options.saveGeneratedThumbnail
    ? resolve(dirname(path), `${parse(path).name}.telegram-thumb.jpg`)
    : resolve(tmpdir(), `${parse(path).name}-${Date.now()}.telegram-thumb.jpg`)
  const thumbnail = await generatePdfThumbnail({
    pdfPath: path,
    outputPath: thumbnailPath,
  })

  return {
    _: 'inputThumbnail',
    thumbnail: createLocalInputFile(thumbnail.outputPath ?? thumbnailPath),
    width: thumbnail.width,
    height: thumbnail.height,
  }
}

export function getFileName(path: string): string {
  return basename(path)
}

function ensureConfigured(): void {
  if (isConfigured) {
    return
  }

  tdl.configure({
    tdjson: getTdjson(),
  })
  isConfigured = true
}

function isAuthorizationStateClosedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(AUTHORIZATION_STATE_CLOSED_ERROR)
}

function waitForMessageSendCompletion(client: TdClient, message: TdMessage, chatId: number): Promise<number> {
  if (!isMessagePending(message)) {
    return Promise.resolve(message.id)
  }

  const temporaryMessageId = message.id

  return new Promise<number>((resolvePromise, rejectPromise) => {
    const cleanup = (): void => {
      clearTimeout(timeout)
      client.off('update', onUpdate)
      client.off('close', onClose)
    }

    const onClose = (): void => {
      cleanup()
      rejectPromise(
        new TdlibMessageSendError(
          `TDLib client closed before message ${temporaryMessageId} finished sending.`,
          [temporaryMessageId],
        ),
      )
    }

    const onUpdate = (update: unknown): void => {
      if (isUpdateMessageSendSucceeded(update) && update.old_message_id === temporaryMessageId) {
        cleanup()
        resolvePromise(update.message.id)
        return
      }

      if (isUpdateMessageSendFailed(update) && update.old_message_id === temporaryMessageId) {
        cleanup()
        rejectPromise(
          new TdlibMessageSendError(`TDLib failed to send message ${temporaryMessageId}: ${update.error.message}`, [
            temporaryMessageId,
          ]),
        )
        return
      }

      if (
        isUpdateDeleteMessages(update) &&
        update.chat_id === chatId &&
        update.message_ids.includes(temporaryMessageId)
      ) {
        cleanup()
        rejectPromise(
          new TdlibMessageSendError(`TDLib deleted pending message ${temporaryMessageId} before send completion.`, [
            temporaryMessageId,
          ]),
        )
      }
    }

    const timeout = setTimeout(() => {
      cleanup()
      rejectPromise(
        new TdlibMessageSendError(`Timed out while waiting for TDLib message ${temporaryMessageId} to finish sending.`, [
          temporaryMessageId,
        ]),
      )
    }, MESSAGE_SEND_TIMEOUT_MS)

    client.on('update', onUpdate)
    client.on('close', onClose)
  })
}

async function waitForMessagesSendCompletion(client: TdClient, messages: TdMessage[], chatId: number): Promise<number[]> {
  const settled = await Promise.allSettled(messages.map(message => waitForMessageSendCompletion(client, message, chatId)))
  const fulfilled = settled
    .filter((result): result is PromiseFulfilledResult<number> => result.status === 'fulfilled')
    .map(result => result.value)
  const rejected = settled.filter((result): result is PromiseRejectedResult => result.status === 'rejected')

  if (rejected.length === 0) {
    return fulfilled
  }

  const pendingMessageIds = rejected.flatMap(result => extractPendingMessageIds(result.reason))
  const messagesText = rejected
    .map(result => (result.reason instanceof Error ? result.reason.message : String(result.reason)))
    .join('; ')

  throw new TdlibMessageSendError(messagesText, pendingMessageIds, { cause: rejected[0]?.reason })
}

async function loadKnownChats(client: TdClient, limit: number): Promise<void> {
  try {
    await invoke<TdBaseObject>(client, {
      _: 'loadChats',
      chat_list: null,
      limit,
    })
  } catch {
    // TDLib returns an error when the chat list is fully loaded; ignoring that keeps the helper idempotent.
  }
}

async function collectKnownChatIds(client: TdClient, query: string, limit: number): Promise<number[]> {
  const results = new Set<number>()

  for (const request of [
    { _: 'searchChats', query, limit },
    { _: 'searchChatsOnServer', query, limit },
  ]) {
    try {
      const payload = await invoke<TdChats>(client, request)
      for (const chatId of payload.chat_ids) {
        results.add(chatId)
      }
    } catch {
      // Continue with any other resolver that may still succeed.
    }
  }

  return [...results]
}

async function getRequiredIntegerOption(client: TdClient, name: string): Promise<number> {
  const option = await invoke<TdBaseObject | TdIntegerOption>(client, {
    _: 'getOption',
    name,
  })

  if (!isIntegerOption(option)) {
    throw new Error(`TDLib option "${name}" is not available as an integer value.`)
  }

  return Number(option.value)
}

async function getBooleanOption(client: TdClient, name: string): Promise<boolean | undefined> {
  try {
    const option = await invoke<TdBaseObject | TdBooleanOption>(client, {
      _: 'getOption',
      name,
    })

    return isBooleanOption(option) ? option.value : undefined
  } catch {
    return undefined
  }
}

function createLinkPreviewOptions(disable: boolean): TdLinkPreviewOptions | null {
  return disable
    ? {
        _: 'linkPreviewOptions',
        is_disabled: true,
      }
    : null
}

function emptyFormattedText(): TdFormattedText {
  return {
    _: 'formattedText',
    text: '',
    entities: [],
  }
}

function isTdError(value: unknown): value is TdError {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_' in value &&
    'code' in value &&
    'message' in value &&
    (value as TdError)._ === 'error'
  )
}

function isBooleanOption(value: TdBaseObject | TdBooleanOption): value is TdBooleanOption {
  return value._ === 'optionValueBoolean'
}

function isIntegerOption(value: TdBaseObject | TdIntegerOption): value is TdIntegerOption {
  return value._ === 'optionValueInteger'
}

function isMessagePending(message: TdMessage): boolean {
  return message.sending_state?._ === 'messageSendingStatePending'
}

function isUpdateMessageSendSucceeded(value: unknown): value is TdUpdateMessageSendSucceeded {
  return typeof value === 'object' && value !== null && (value as TdBaseObject)._ === 'updateMessageSendSucceeded'
}

function isUpdateMessageSendFailed(value: unknown): value is TdUpdateMessageSendFailed {
  return typeof value === 'object' && value !== null && (value as TdBaseObject)._ === 'updateMessageSendFailed'
}

function isUpdateDeleteMessages(value: unknown): value is TdUpdateDeleteMessages {
  return typeof value === 'object' && value !== null && (value as TdBaseObject)._ === 'updateDeleteMessages'
}

function extractPendingMessageIds(error: unknown): number[] {
  return error instanceof TdlibMessageSendError ? error.pendingMessageIds : []
}

function normalizeChannelUsername(value: string): string {
  return value.startsWith('@') ? value.slice(1) : value
}

function isNumericChatId(value: string): boolean {
  return /^-?\d+$/.test(value)
}

function normalizeSessionName(value?: string): string {
  if (!value) {
    return 'default'
  }

  return value.replace(/[^a-zA-Z0-9._-]+/g, '-')
}
