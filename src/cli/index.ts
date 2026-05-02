import { access, constants, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { parse, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { publishBotApiPlan } from '../transport-bot-api/index.js'
import {
  closeTdlibClient,
  createLoggedInTdlibClient,
  logoutTdlibSession,
  publishTdlibPlan,
  resolveTdlibCapabilities,
  searchChats,
  type TdlibAccountTier,
} from '../transport-tdlib/index.js'
import {
  type AttachmentConfig,
  type BotHtmlRenderConfig,
  compileMarkdownSource,
  type Diagnostic,
  type HeadingStylesConfig,
  type HeadingTextStyle,
  type OverflowMode,
  type PublishCapabilities,
  type PublishTarget,
  type SplitRulesConfig,
  planPost,
  preparePost,
} from '../core/index.js'
import { config as loadEnv } from 'dotenv'

const DEFAULT_CONFIG_FILE = 'md2tg.jsonc'

interface CliOptions {
  command: string
  file?: string
  token?: string
  chat?: string
  query?: string
  target?: PublishTarget
  profile?: string
  config?: string
  dryRun: boolean
  output?: string
  saveHtml?: string
  saveThumbnails: boolean
  overflowMode?: OverflowMode
  disableWebPagePreview?: boolean
}

interface FragmentConfig {
  preambleFile?: string
  postambleFile?: string
}

interface PublishConfig {
  sendRetries?: number
  minPostIntervalMs?: number
  postStateFile?: string
  postLockFile?: string
}

interface TdlibConfig {
  sessionRootDir?: string
  useFileDatabase?: boolean
  useChatInfoDatabase?: boolean
  useMessageDatabase?: boolean
  useSecretChats?: boolean
  systemLanguageCode?: string
  deviceModel?: string
  applicationVersion?: string
}

interface TdlibProfileConfig {
  sessionName?: string
  databaseEncryptionKey?: string
}

interface ProfileConfig {
  target?: PublishTarget
  chatId?: string
  disableWebPagePreview?: boolean
  overflowMode?: OverflowMode
  continuationPreambleMarkdown?: string
  publish?: PublishConfig
  attachments?: AttachmentConfig & {
    generateThumbnails?: boolean
  }
  splitRules?: SplitRulesConfig
  headingDecorations?: BotHtmlRenderConfig['headingDecorations']
  headingStyles?: HeadingStylesConfig
  sectionHeadingRules?: BotHtmlRenderConfig['sectionHeadingRules']
  fragments?: FragmentConfig
  accountTier?: TdlibAccountTier
  tdlib?: TdlibProfileConfig
}

interface ConfigFile {
  defaultTarget?: PublishTarget
  overflowMode?: OverflowMode
  continuationPreambleMarkdown?: string
  publish?: PublishConfig
  attachments?: AttachmentConfig & {
    generateThumbnails?: boolean
  }
  splitRules?: SplitRulesConfig
  headingDecorations?: BotHtmlRenderConfig['headingDecorations']
  headingStyles?: HeadingStylesConfig
  sectionHeadingRules?: BotHtmlRenderConfig['sectionHeadingRules']
  fragments?: FragmentConfig
  tdlib?: TdlibConfig
  profiles?: Record<string, ProfileConfig>
}

interface ProfileSelection {
  name?: string
  profile?: ProfileConfig
  autoSelectedForTarget: boolean
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2))
  const invocationCwd = getInvocationCwd()
  await loadNearestEnvFile(invocationCwd)

  if (options.command === 'compile') {
    await runCompileCommand(options, invocationCwd)
    return
  }

  if (options.command === 'resolve-chat') {
    await runResolveChatCommand(options, invocationCwd)
    return
  }

  if (options.command === 'logout') {
    await runLogoutCommand(options, invocationCwd)
    return
  }

  if (options.command !== 'post') {
    printUsage()
    process.exitCode = 1
    return
  }

  if (!options.file) {
    throw new Error('Missing required --file argument.')
  }

  const configPath = resolveConfigPath(invocationCwd, options.config)
  const config = await loadConfig(configPath, { required: options.config !== undefined })
  const initialSelection = resolveProfileSelection(config, options.profile)
  const requestedTarget = options.target ?? initialSelection.profile?.target ?? config.defaultTarget ?? 'bot-api'
  const selection = resolveProfileSelection(config, options.profile, requestedTarget)
  const profile = selection.profile
  const target = options.target ?? profile?.target ?? config.defaultTarget ?? 'bot-api'
  reportAutoSelectedProfile(selection, target)
  const overflowMode = options.overflowMode ?? profile?.overflowMode ?? config.overflowMode ?? 'fail'
  const continuationPreambleMarkdown =
    profile?.continuationPreambleMarkdown ?? config.continuationPreambleMarkdown ?? '_(continued...)_'
  const attachmentConfig = resolveAttachmentConfig(config.attachments, profile?.attachments)
  const generateDocumentThumbnails =
    profile?.attachments?.generateThumbnails ?? config.attachments?.generateThumbnails ?? false
  const publishConfig = resolvePublishConfig(config.publish, profile?.publish)
  const splitRules = resolveSplitRules(config.splitRules, profile?.splitRules)
  const fragmentConfig = resolveFragmentConfig(config.fragments, profile?.fragments)
  const renderConfig = resolveRenderConfig(
    config.headingDecorations,
    profile?.headingDecorations,
    config.headingStyles,
    profile?.headingStyles,
    config.sectionHeadingRules,
    profile?.sectionHeadingRules,
  )

  const markdownPath = resolve(invocationCwd, options.file)
  const markdown = await loadMarkdownSource(markdownPath, configPath, fragmentConfig)
  const prepared = preparePost({
    markdown,
    baseDir: dirname(markdownPath),
    attachmentConfig,
    renderConfig,
  })

  reportWarnings(prepared.diagnostics)
  throwOnErrors(prepared.diagnostics)

  const continuationBlocks =
    overflowMode === 'split' ? parseContinuationPreambleMarkdown(continuationPreambleMarkdown, invocationCwd) : []

  if (options.saveHtml) {
    const htmlPath = resolve(invocationCwd, options.saveHtml)
    await writeFile(htmlPath, `${prepared.renderedHtml.bodyHtml}\n`, 'utf8')
    process.stdout.write(`Saved HTML to ${htmlPath}.\n`)
  }

  const capabilities =
    target === 'tdlib'
      ? await resolveTdlibPlanningCapabilities(configPath, config.tdlib, profile)
      : resolveBotApiCapabilities()

  const plan = planPost({
    document: prepared.document,
    renderedHtml: prepared.renderedHtml,
    capabilities,
    overflowMode,
    continuationBlocks,
    renderConfig,
    splitRules,
  })

  reportWarnings(plan.diagnostics)
  throwOnErrors(plan.diagnostics)

  if (options.dryRun) {
    process.stdout.write(
      `${formatDryRunSummary(
        prepared.document.mediaPosition,
        plan.steps.length,
        overflowMode,
        prepared.document.attachments.length,
      )}\n`,
    )
    process.stdout.write(`${prepared.renderedHtml.bodyHtml}\n`)
    return
  }

  const chatId = resolveEffectiveChatId(target, options.chat, profile?.chatId)

  if (!chatId) {
    throw new Error(
      target === 'tdlib'
        ? 'Missing Telegram chat id. Pass --chat, set profiles.<name>.chatId, or set TELEGRAM_CHAT_ID / TELEGRAM_TDLIB_CHAT_ID.'
        : 'Missing Telegram chat id. Pass --chat, set profiles.<name>.chatId, or set TELEGRAM_CHAT_ID / TELEGRAM_BOT_CHAT_ID.',
    )
  }

  if (target === 'tdlib') {
    if (options.token) {
      throw new Error('The --token flag is only supported for target=bot-api.')
    }

    const publishResult = await publishTdlibPlan(plan, {
      ...resolveTdlibSessionConfig(configPath, config.tdlib, profile),
      ...resolvePublishRuntimeConfig(configPath, publishConfig),
      chatId,
      accountTier: profile?.accountTier ?? 'auto',
      disableWebPagePreview: options.disableWebPagePreview ?? profile?.disableWebPagePreview ?? false,
      generateDocumentThumbnails,
      saveGeneratedThumbnails: options.saveThumbnails,
      sendRetries: publishConfig?.sendRetries,
    })

    process.stdout.write(
      `Published ${publishResult.messageIds.length} message(s) to ${chatId} via TDLib (chat ${publishResult.resolvedChatId}).\n`,
    )
    return
  }

  const token = options.token ?? process.env.TELEGRAM_BOT_TOKEN

  if (!token) {
    throw new Error('Missing Telegram bot token. Pass --token or set TELEGRAM_BOT_TOKEN.')
  }

  const publishResult = await publishBotApiPlan(plan, {
    token,
    ...resolvePublishRuntimeConfig(configPath, publishConfig),
    chatId,
    disableWebPagePreview: options.disableWebPagePreview ?? profile?.disableWebPagePreview ?? false,
    generateDocumentThumbnails,
    saveGeneratedThumbnails: options.saveThumbnails,
    sendRetries: publishConfig?.sendRetries,
  })

  process.stdout.write(`Published ${publishResult.messageIds.length} message(s) to ${chatId}.\n`)
}

function resolveBotApiCapabilities(): PublishCapabilities {
  return {
    target: 'bot-api',
    messageLimit: 4096,
    captionLimit: 1024,
    mediaGroupMinItems: 2,
    mediaGroupMaxItems: 10,
    supportsReply: true,
  }
}

async function resolveTdlibPlanningCapabilities(
  configPath: string,
  globalTdlibConfig: TdlibConfig | undefined,
  profile: ProfileConfig | undefined,
): Promise<PublishCapabilities> {
  const resolution = await resolveTdlibCapabilities({
    ...resolveTdlibSessionConfig(configPath, globalTdlibConfig, profile),
    accountTier: profile?.accountTier ?? 'auto',
  })

  reportTdlibWarnings(resolution.warnings)
  return resolution.capabilities
}

function resolveTdlibSessionConfig(
  configPath: string,
  globalTdlibConfig: TdlibConfig | undefined,
  profile: ProfileConfig | undefined,
) {
  const configDir = dirname(configPath)

  return {
    apiId: readRequiredIntegerEnv('TELEGRAM_TDLIB_API_ID'),
    apiHash: readRequiredStringEnv('TELEGRAM_TDLIB_API_HASH'),
    sessionName: profile?.tdlib?.sessionName ?? 'default',
    sessionRootDir: resolve(configDir, globalTdlibConfig?.sessionRootDir ?? '.md2tg/tdlib'),
    databaseEncryptionKey: profile?.tdlib?.databaseEncryptionKey,
    useFileDatabase: globalTdlibConfig?.useFileDatabase,
    useChatInfoDatabase: globalTdlibConfig?.useChatInfoDatabase,
    useMessageDatabase: globalTdlibConfig?.useMessageDatabase,
    useSecretChats: globalTdlibConfig?.useSecretChats,
    systemLanguageCode: globalTdlibConfig?.systemLanguageCode,
    deviceModel: globalTdlibConfig?.deviceModel,
    applicationVersion: globalTdlibConfig?.applicationVersion,
  }
}

function readRequiredStringEnv(name: string): string {
  const value = process.env[name]

  if (!value || value.trim().length === 0) {
    throw new Error(`Missing ${name}. Set it in .env for TDLib publishing.`)
  }

  return value
}

function readRequiredIntegerEnv(name: string): number {
  const value = Number(readRequiredStringEnv(name))

  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}. Expected a positive integer.`)
  }

  return value
}

function readOptionalEnv(name: string): string | undefined {
  const value = process.env[name]
  if (!value || value.trim().length === 0) {
    return undefined
  }

  return value
}

function resolveEffectiveChatId(target: PublishTarget, cliChat: string | undefined, profileChat: string | undefined): string | undefined {
  const targetEnv = target === 'tdlib' ? readOptionalEnv('TELEGRAM_TDLIB_CHAT_ID') : readOptionalEnv('TELEGRAM_BOT_CHAT_ID')
  const sharedEnv = readOptionalEnv('TELEGRAM_CHAT_ID')

  return cliChat ?? profileChat ?? targetEnv ?? sharedEnv
}

function resolveProfileSelection(
  config: ConfigFile,
  requestedProfileName: string | undefined,
  target?: PublishTarget,
): ProfileSelection {
  if (requestedProfileName) {
    return {
      name: requestedProfileName,
      profile: config.profiles?.[requestedProfileName],
      autoSelectedForTarget: false,
    }
  }

  const defaultProfile = config.profiles?.default

  if (!target || defaultProfile === undefined || defaultProfile.target === target) {
    return {
      name: defaultProfile ? 'default' : undefined,
      profile: defaultProfile,
      autoSelectedForTarget: false,
    }
  }

  const matchingProfiles = Object.entries(config.profiles ?? {}).filter(([, profile]) => profile.target === target)

  if (matchingProfiles.length === 1) {
    const [name, profile] = matchingProfiles[0] ?? []
    return {
      name,
      profile,
      autoSelectedForTarget: true,
    }
  }

  return {
    name: defaultProfile ? 'default' : undefined,
    profile: defaultProfile,
    autoSelectedForTarget: false,
  }
}

function reportAutoSelectedProfile(selection: ProfileSelection, target: PublishTarget): void {
  if (!selection.autoSelectedForTarget || !selection.name) {
    return
  }

  process.stderr.write(
    `Warning [AUTO_SELECTED_PROFILE]: Using profile "${selection.name}" because it is the only profile configured for target=${target}.\n`,
  )
}

function getInvocationCwd(): string {
  return process.env.INIT_CWD || process.cwd()
}

async function fileExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue, constants.F_OK)
    return true
  } catch {
    return false
  }
}

function collectDirectoryAncestors(startDir: string): string[] {
  const directories: string[] = []
  let current = resolve(startDir)

  while (true) {
    directories.push(current)
    const parent = dirname(current)
    if (parent === current) {
      return directories
    }
    current = parent
  }
}

async function loadNearestEnvFile(invocationCwd: string): Promise<string | undefined> {
  for (const directory of collectDirectoryAncestors(invocationCwd)) {
    const envPath = resolve(directory, '.env')
    if (await fileExists(envPath)) {
      loadEnv({ path: envPath, quiet: true })
      return envPath
    }
  }

  return undefined
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    command: argv[0] ?? '',
    dryRun: false,
    saveThumbnails: false,
  }

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]

    switch (arg) {
      case '--file':
        options.file = argv[++index]
        break
      case '--token':
        options.token = argv[++index]
        break
      case '--chat':
        options.chat = argv[++index]
        break
      case '--query':
        options.query = argv[++index]
        break
      case '--target':
        if (options.command === 'resolve-chat') {
          throw new Error('The resolve-chat command does not accept --target. It always uses TDLib.')
        }
        options.target = argv[++index] as PublishTarget
        break
      case '--profile':
        options.profile = argv[++index]
        break
      case '--config':
        options.config = argv[++index]
        break
      case '--output':
        options.output = argv[++index]
        break
      case '--save-html':
        options.saveHtml = argv[++index]
        break
      case '--save-thumbnails':
        options.saveThumbnails = true
        break
      case '--overflow-mode':
        options.overflowMode = argv[++index] as OverflowMode
        break
      case '--dry-run':
        options.dryRun = true
        break
      case '--disable-web-page-preview':
        options.disableWebPagePreview = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return options
}

async function loadConfig(configPath: string, options: { required: boolean }): Promise<ConfigFile> {
  try {
    await stat(configPath)
  } catch (error_) {
    if (options.required) {
      const reason = error_ instanceof Error ? error_.message : String(error_)
      throw new Error(`Config file not found: ${configPath} (${reason})`)
    }

    return {}
  }

  const raw = await readFile(configPath, 'utf8')
  const errors: ParseError[] = []
  const parsed = parse(raw, errors, { allowTrailingComma: true }) as ConfigFile

  if (errors.length > 0) {
    const formattedErrors = errors
      .map(error => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(', ')
    throw new Error(`Invalid JSONC config at ${configPath}: ${formattedErrors}`)
  }

  return parsed ?? {}
}

function resolveConfigPath(invocationCwd: string, configPath?: string): string {
  return resolve(invocationCwd, configPath ?? DEFAULT_CONFIG_FILE)
}

async function loadMarkdownSource(
  markdownPath: string,
  configPath: string,
  fragmentConfig?: FragmentConfig,
): Promise<string> {
  const mainMarkdown = await readFile(markdownPath, 'utf8')
  const configDir = dirname(configPath)
  const parts: string[] = []

  if (fragmentConfig?.preambleFile) {
    parts.push(await readFile(resolve(configDir, fragmentConfig.preambleFile), 'utf8'))
  }

  parts.push(mainMarkdown)

  if (fragmentConfig?.postambleFile) {
    parts.push(await readFile(resolve(configDir, fragmentConfig.postambleFile), 'utf8'))
  }

  return parts.join('\n\n').trim()
}

async function runCompileCommand(options: CliOptions, invocationCwd: string): Promise<void> {
  if (!options.file) {
    throw new Error('Missing required --file argument.')
  }

  const configPath = resolveConfigPath(invocationCwd, options.config)
  const config = await loadConfig(configPath, { required: options.config !== undefined })
  const selection = resolveProfileSelection(config, options.profile)
  const profile = selection.profile
  const fragmentConfig = resolveFragmentConfig(config.fragments, profile?.fragments)
  const markdownPath = resolve(invocationCwd, options.file)
  const composedMarkdown = await loadMarkdownSource(markdownPath, configPath, fragmentConfig)
  const compiledMarkdown = compileMarkdownSource(composedMarkdown)

  if (options.output) {
    const outputPath = resolve(invocationCwd, options.output)
    await writeFile(outputPath, `${compiledMarkdown}\n`, 'utf8')
    process.stdout.write(`Saved compiled Markdown to ${outputPath}.\n`)
    return
  }

  process.stdout.write(`${compiledMarkdown}\n`)
}

async function runResolveChatCommand(options: CliOptions, invocationCwd: string): Promise<void> {
  const query = options.query ?? options.chat

  if (!query) {
    throw new Error('Missing required --query argument.')
  }

  const configPath = resolveConfigPath(invocationCwd, options.config)
  const config = await loadConfig(configPath, { required: options.config !== undefined })
  const selection = resolveProfileSelection(config, options.profile, 'tdlib')
  const profile = selection.profile
  const target: PublishTarget = 'tdlib'
  reportAutoSelectedProfile(selection, target)

  const client = await createLoggedInTdlibClient(resolveTdlibSessionConfig(configPath, config.tdlib, profile))

  try {
    const results = await searchChats(client, query, 20)

    if (results.length === 0) {
      throw new Error(
        'No TDLib chats matched the query. For private channels, make sure the authorized account already knows the chat and search by channel title.',
      )
    }

    for (const result of results) {
      process.stdout.write(
        `chat_id=${result.id} source=${result.source} title=${JSON.stringify(result.title)} env=TELEGRAM_CHAT_ID=${result.id}\n`,
      )
    }
  } finally {
    await closeTdlibClient(client)
  }
}

async function runLogoutCommand(options: CliOptions, invocationCwd: string): Promise<void> {
  const configPath = resolveConfigPath(invocationCwd, options.config)
  const config = await loadConfig(configPath, { required: options.config !== undefined })
  const initialSelection = resolveProfileSelection(config, options.profile)
  const requestedTarget = initialSelection.profile?.target ?? config.defaultTarget ?? 'tdlib'
  const selection = resolveProfileSelection(config, options.profile, requestedTarget)
  const profile = selection.profile
  const target = profile?.target ?? config.defaultTarget ?? 'tdlib'

  if (target !== 'tdlib') {
    throw new Error('The logout command currently supports only TDLib sessions.')
  }

  reportAutoSelectedProfile(selection, target)

  await logoutTdlibSession(resolveTdlibSessionConfig(configPath, config.tdlib, profile))
  process.stdout.write(
    `Logged out TDLib session "${profile?.tdlib?.sessionName ?? 'default'}"${selection.name ? ` for profile "${selection.name}"` : ''}.\n`,
  )
}

function reportWarnings(diagnostics: Diagnostic[]): void {
  for (const diagnostic of diagnostics.filter(entry => entry.level === 'warning')) {
    process.stderr.write(`Warning [${diagnostic.code}]: ${diagnostic.message}\n`)
  }
}

function reportTdlibWarnings(warnings: Array<{ code: string; message: string }>): void {
  for (const warning of warnings) {
    process.stderr.write(`Warning [${warning.code}]: ${warning.message}\n`)
  }
}

function throwOnErrors(diagnostics: Diagnostic[]): void {
  const errors = diagnostics.filter(entry => entry.level === 'error')
  if (errors.length === 0) {
    return
  }

  throw new Error(errors.map(entry => `[${entry.code}] ${entry.message}`).join('\n'))
}

function formatDryRunSummary(
  mediaPosition: string,
  stepCount: number,
  overflowMode: OverflowMode,
  attachmentCount: number,
): string {
  return `[dry-run] media-position=${mediaPosition} overflow-mode=${overflowMode} steps=${stepCount} attachments=${attachmentCount}`
}

function parseContinuationPreambleMarkdown(markdown: string, baseDir: string) {
  if (markdown.trim().length === 0) {
    return []
  }

  const prepared = preparePost({
    markdown,
    baseDir,
  })

  reportWarnings(prepared.diagnostics)
  throwOnErrors(prepared.diagnostics)

  if (prepared.document.media.length > 0) {
    throw new Error('Continuation preamble Markdown must not contain media.')
  }

  return prepared.document.blocks
}

function resolveAttachmentConfig(
  globalConfig?: AttachmentConfig,
  profileConfig?: AttachmentConfig,
): AttachmentConfig | undefined {
  if (!globalConfig && !profileConfig) {
    return undefined
  }

  return {
    sectionTitle: profileConfig?.sectionTitle ?? globalConfig?.sectionTitle,
    allowedExtensions: profileConfig?.allowedExtensions ?? globalConfig?.allowedExtensions,
  }
}

function resolvePublishConfig(globalConfig?: PublishConfig, profileConfig?: PublishConfig): PublishConfig | undefined {
  if (!globalConfig && !profileConfig) {
    return undefined
  }

  const sendRetries = profileConfig?.sendRetries ?? globalConfig?.sendRetries
  const minPostIntervalMs = profileConfig?.minPostIntervalMs ?? globalConfig?.minPostIntervalMs
  const postStateFile = profileConfig?.postStateFile ?? globalConfig?.postStateFile
  const postLockFile = profileConfig?.postLockFile ?? globalConfig?.postLockFile

  if (sendRetries !== undefined && (!Number.isInteger(sendRetries) || sendRetries < 1)) {
    throw new Error('Invalid publish.sendRetries value. Expected an integer greater than or equal to 1.')
  }

  if (minPostIntervalMs !== undefined && (!Number.isInteger(minPostIntervalMs) || minPostIntervalMs < 0)) {
    throw new Error('Invalid publish.minPostIntervalMs value. Expected an integer greater than or equal to 0.')
  }

  return { sendRetries, minPostIntervalMs, postStateFile, postLockFile }
}

function resolvePublishRuntimeConfig(configPath: string, publishConfig?: PublishConfig) {
  const configDir = dirname(configPath)

  return {
    minPostIntervalMs: publishConfig?.minPostIntervalMs,
    postStateFile: resolve(configDir, publishConfig?.postStateFile ?? '.md2tg/publish-state.json'),
    postLockFile: resolve(configDir, publishConfig?.postLockFile ?? '.md2tg/publish-state.lock'),
  }
}

function resolveFragmentConfig(
  globalConfig?: FragmentConfig,
  profileConfig?: FragmentConfig,
): FragmentConfig | undefined {
  if (!globalConfig && !profileConfig) {
    return undefined
  }

  return {
    preambleFile: profileConfig?.preambleFile ?? globalConfig?.preambleFile,
    postambleFile: profileConfig?.postambleFile ?? globalConfig?.postambleFile,
  }
}

function resolveRenderConfig(
  globalHeadingDecorations?: BotHtmlRenderConfig['headingDecorations'],
  profileHeadingDecorations?: BotHtmlRenderConfig['headingDecorations'],
  globalHeadingStyles?: BotHtmlRenderConfig['headingStyles'],
  profileHeadingStyles?: BotHtmlRenderConfig['headingStyles'],
  globalSectionHeadingRules?: BotHtmlRenderConfig['sectionHeadingRules'],
  profileSectionHeadingRules?: BotHtmlRenderConfig['sectionHeadingRules'],
): BotHtmlRenderConfig | undefined {
  const h1 = mergeHeadingDecoration(globalHeadingDecorations?.h1, profileHeadingDecorations?.h1)
  const h2 = mergeHeadingDecoration(globalHeadingDecorations?.h2, profileHeadingDecorations?.h2)
  const h3Decoration = mergeHeadingDecoration(globalHeadingDecorations?.h3, profileHeadingDecorations?.h3)
  const h3 = profileHeadingStyles?.h3 ?? globalHeadingStyles?.h3
  const sectionHeadingRules = profileSectionHeadingRules ?? globalSectionHeadingRules

  validateSectionHeadingRules(sectionHeadingRules)
  validateHeadingStyles(h3)

  if (
    h1 === undefined &&
    h2 === undefined &&
    h3Decoration === undefined &&
    h3 === undefined &&
    sectionHeadingRules === undefined
  ) {
    return undefined
  }

  return {
    headingDecorations: {
      h1,
      h2,
      h3: h3Decoration,
    },
    headingStyles: {
      h3,
    },
    sectionHeadingRules,
  }
}

function validateSectionHeadingRules(sectionHeadingRules?: BotHtmlRenderConfig['sectionHeadingRules']): void {
  for (const rule of sectionHeadingRules ?? []) {
    try {
      new RegExp(rule.pattern)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`Invalid section heading rule regex "${rule.pattern}": ${message}`)
    }
  }
}

function mergeHeadingDecoration(
  globalConfig?: NonNullable<BotHtmlRenderConfig['headingDecorations']>[keyof NonNullable<
    BotHtmlRenderConfig['headingDecorations']
  >],
  profileConfig?: NonNullable<BotHtmlRenderConfig['headingDecorations']>[keyof NonNullable<
    BotHtmlRenderConfig['headingDecorations']
  >],
) {
  const prefix = profileConfig?.prefix ?? globalConfig?.prefix
  const suffix = profileConfig?.suffix ?? globalConfig?.suffix

  if (prefix === undefined && suffix === undefined) {
    return undefined
  }

  return { prefix, suffix }
}

function validateHeadingStyles(styles?: HeadingTextStyle[]): void {
  const allowedStyles = new Set<HeadingTextStyle>(['bold', 'italic', 'underline', 'strike', 'code'])

  for (const style of styles ?? []) {
    if (!allowedStyles.has(style)) {
      throw new Error(`Unsupported heading style "${style}". Allowed values: bold, italic, underline, strike, code`)
    }
  }
}

function resolveSplitRules(
  globalConfig?: SplitRulesConfig,
  profileConfig?: SplitRulesConfig,
): SplitRulesConfig | undefined {
  if (!globalConfig && !profileConfig) {
    return undefined
  }

  return {
    keepParagraphIntact: profileConfig?.keepParagraphIntact ?? globalConfig?.keepParagraphIntact,
    keepHeadingWithNextBlock: profileConfig?.keepHeadingWithNextBlock ?? globalConfig?.keepHeadingWithNextBlock,
    keepColonPreambleWithList: profileConfig?.keepColonPreambleWithList ?? globalConfig?.keepColonPreambleWithList,
    keepColonPreambleWithQuote: profileConfig?.keepColonPreambleWithQuote ?? globalConfig?.keepColonPreambleWithQuote,
  }
}

function printUsage(): void {
  process.stdout.write(`Usage:
  md2tg post --file ./post.md --chat @channel --token 123:ABC
  md2tg compile --file ./post.md --output ./compiled.md
  md2tg resolve-chat --query "Channel Title"
  md2tg logout --profile default

Options:
  --file <path>                     Markdown file to compile or publish
  --query <text>                    Chat query for resolve-chat
  --chat <id|@username>             Telegram target chat (@username or numeric id)
  --token <token>                   Telegram bot token for target=bot-api
  --profile <name>                  Named profile from md2tg.jsonc
  --target <bot-api|tdlib>          Publish target for post
  --config <path>                   Path to md2tg.jsonc
  --output <path>                   Save compiled Markdown for the compile command
  --overflow-mode <fail|split>      Overflow handling strategy
  --save-html <path>                Save rendered HTML to a file
  --save-thumbnails                 Keep generated PDF thumbnails next to the source PDF files
  --dry-run                         Print the rendered HTML instead of sending
  --disable-web-page-preview        Disable link previews
`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
})
