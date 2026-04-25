import type { PublishCapabilities, PublishPlan } from '../core/index.js'

export type TdlibAccountTier = 'auto' | 'standard' | 'premium'
export type TdlibResolvedAccountTier = 'standard' | 'premium'

export interface TdlibWarning {
  code: string
  message: string
}

export interface TdlibSessionConfig {
  apiId: number
  apiHash: string
  sessionName?: string
  sessionRootDir?: string
  databaseEncryptionKey?: string
  useFileDatabase?: boolean
  useChatInfoDatabase?: boolean
  useMessageDatabase?: boolean
  useSecretChats?: boolean
  systemLanguageCode?: string
  deviceModel?: string
  applicationVersion?: string
}

export interface TdlibCapabilityConfig extends TdlibSessionConfig {
  accountTier?: TdlibAccountTier
}

export interface TdlibCapabilityResolution {
  capabilities: PublishCapabilities
  accountTierRequested: TdlibAccountTier
  accountTierResolved: TdlibResolvedAccountTier
  accountIsPremium?: boolean
  warnings: TdlibWarning[]
}

export interface TdlibPublishConfig extends TdlibCapabilityConfig {
  chatId: string
  disableWebPagePreview?: boolean
  generateDocumentThumbnails?: boolean
  saveGeneratedThumbnails?: boolean
  sendRetries?: number
  minPostIntervalMs?: number
  postStateFile?: string
  postLockFile?: string
}

export interface TdlibPublishResult {
  target: 'tdlib'
  messageIds: number[]
  resolvedChatId: number
  resolvedChatTitle: string
  accountTierResolved: TdlibResolvedAccountTier
  warnings: TdlibWarning[]
}

export interface TdlibResolvedChat {
  id: number
  title: string
}

export interface TdlibChatSearchResult extends TdlibResolvedChat {
  source: 'chat-id' | 'public-username' | 'known-chat-search'
}

export interface TdlibRuntimeSnapshot {
  accountIsPremium?: boolean
  messageLimit: number
  currentCaptionLimit: number
  standardCaptionLimit?: number
  premiumCaptionLimit?: number
}

export interface TdlibPremiumLimit {
  defaultValue: number
  premiumValue: number
}

export interface TdlibPublishContext {
  plan: PublishPlan
  config: TdlibPublishConfig
}
