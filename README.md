# markdown-to-telegram

Prepare and publish Markdown articles to Telegram through Telegram Bot API or TDLib.

The package includes:

- a Markdown parser and Telegram HTML renderer;
- publication planning for Telegram message, caption, album, and attachment limits;
- Bot API and TDLib publishers;
- PDF thumbnail generation for document uploads;
- the `md2tg` CLI.

## Requirements

- Node.js 20 or newer.
- For Bot API publishing: a Telegram bot token and a target chat.
- For TDLib publishing: Telegram API ID/hash and an authorized TDLib session.

## Install

```bash
npm install markdown-to-telegram
```

For global CLI usage:

```bash
npm install -g markdown-to-telegram
md2tg --help
```

## CLI

```bash
md2tg post --file ./post.md --dry-run
md2tg post --file ./post.md --profile default
md2tg compile --file ./post.md --output ./compiled.md
md2tg resolve-chat --query "Private Channel Title" --profile account-main
md2tg logout --profile account-main
```

Commands:

- `post`: prepares, renders, plans, and optionally publishes a Markdown post.
- `compile`: composes fragments and strips HTML comments without rendering.
- `resolve-chat`: resolves a TDLib chat ID by public username, numeric ID, or known chat title.
- `logout`: logs out the selected TDLib session.

Common options:

- `--file <path>`: Markdown file for `post` or `compile`.
- `--config <path>`: path to `md2tg.jsonc`.
- `--profile <name>`: named profile from config.
- `--target <bot-api|tdlib>`: publish target override.
- `--chat <id|@username>`: target chat override.
- `--token <token>`: Bot API token override.
- `--dry-run`: print plan summary and rendered HTML without publishing.
- `--save-html <path>`: save rendered Telegram HTML.
- `--overflow-mode <fail|split>`: fail on overflow or split into continuation messages.
- `--disable-web-page-preview`: disable link previews for message steps.
- `--save-thumbnails`: keep generated PDF thumbnails next to source PDFs.

## Configuration

The CLI reads `md2tg.jsonc` from the invocation directory unless `--config <path>` is passed. No other config filenames are tried.

If `md2tg.jsonc` is absent and `--config` is not passed, the CLI runs with an empty config and uses CLI flags plus environment variables.

Example:

```jsonc
{
  "defaultTarget": "bot-api",
  "overflowMode": "fail",
  "publish": {
    "sendRetries": 3,
    "minPostIntervalMs": 1000,
    "postStateFile": "./.md2tg/publish-state.json",
    "postLockFile": "./.md2tg/publish-state.lock",
  },
  "tdlib": {
    "sessionRootDir": "./.md2tg/tdlib",
    "useFileDatabase": true,
    "useChatInfoDatabase": true,
    "useMessageDatabase": true,
  },
  "fragments": {
    "preambleFile": "./fragments/preamble.md",
    "postambleFile": "./fragments/postamble.md",
  },
  "profiles": {
    "default": {
      "target": "bot-api",
      "chatId": "@example_channel",
      "disableWebPagePreview": false,
    },
    "account-main": {
      "target": "tdlib",
      "chatId": "@example_channel",
      "accountTier": "auto",
      "tdlib": {
        "sessionName": "main-account",
      },
    },
  },
}
```

See [examples/md2tg.jsonc](./examples/md2tg.jsonc).

## Environment

The CLI loads the first `.env` found in the invocation directory or its parents. Library APIs never read `.env`; pass all secrets and runtime values explicitly.

Supported variables:

```bash
TELEGRAM_BOT_TOKEN=123456:ABCDEF
TELEGRAM_CHAT_ID=@example_channel
TELEGRAM_BOT_CHAT_ID=@example_channel
TELEGRAM_TDLIB_CHAT_ID=1234567890123
TELEGRAM_TDLIB_API_ID=123456
TELEGRAM_TDLIB_API_HASH=0123456789abcdef0123456789abcdef
```

Lookup order for chat IDs:

- Bot API: `--chat`, profile `chatId`, `TELEGRAM_BOT_CHAT_ID`, `TELEGRAM_CHAT_ID`.
- TDLib: `--chat`, profile `chatId`, `TELEGRAM_TDLIB_CHAT_ID`, `TELEGRAM_CHAT_ID`.

## Markdown Rules

Supported post shapes:

```md
# Text only

Post body.
```

```md
![Image](./image.jpg)

# Media first

Post body.
```

```md
# Text first

Post body.

![Image](./image.jpg)
```

Media blocks must be one contiguous group at the top or bottom of the document. Inline images, multiple separated media groups, raw HTML blocks, and media both before and after text are rejected with diagnostics.

Supported formatting includes headings, paragraphs, lists, blockquotes, fenced code blocks, rules, bold, italic, strike, inline code, links, and line breaks. HTML comments are stripped before parsing.

## Attachments

Attachments are declared in a dedicated heading section, enabled by config:

```jsonc
{
  "attachments": {
    "sectionTitle": "Attachments",
    "generateThumbnails": true,
    "allowedExtensions": [".pdf", ".zip", ".docx"],
  },
}
```

Markdown:

```md
## Attachments

- [Report](./report.pdf)
```

Local PDF attachments can receive generated JPEG thumbnails for Telegram document previews.

## Library API

Main import:

```ts
import {
  prepareMarkdownToTelegram,
  publishMarkdownToTelegram,
} from 'markdown-to-telegram'
```

Subpath imports:

```ts
import { preparePost, planPost, renderBotHtml } from 'markdown-to-telegram/core'
import { publishBotApiPlan } from 'markdown-to-telegram/transport-bot-api'
import { publishTdlibPlan, resolveTdlibCapabilities } from 'markdown-to-telegram/transport-tdlib'
import { generatePdfThumbnail } from 'markdown-to-telegram/pdf-thumbnail'
```

Prepare and plan:

```ts
import { prepareMarkdownToTelegram } from 'markdown-to-telegram'

const result = prepareMarkdownToTelegram({
  markdown,
  baseDir: process.cwd(),
  plan: {
    capabilities: {
      target: 'bot-api',
      messageLimit: 4096,
      captionLimit: 1024,
      mediaGroupMinItems: 2,
      mediaGroupMaxItems: 10,
      supportsReply: true,
    },
    overflowMode: 'split',
    continuationMarkdown: '_(continued...)_',
  },
})

if (result.diagnostics.some(diagnostic => diagnostic.level === 'error')) {
  throw new Error('Post is invalid')
}

console.log(result.renderedHtml.bodyHtml)
console.log(result.plan?.steps)
```

Publish through Bot API:

```ts
import { publishMarkdownToTelegram } from 'markdown-to-telegram'

const result = await publishMarkdownToTelegram({
  target: 'bot-api',
  markdown,
  baseDir: process.cwd(),
  publish: {
    token: process.env.TELEGRAM_BOT_TOKEN!,
    chatId: '@example_channel',
    sendRetries: 3,
  },
})

console.log(result.publish.messageIds)
```

Publish through TDLib:

```ts
import { publishMarkdownToTelegram } from 'markdown-to-telegram'

const result = await publishMarkdownToTelegram({
  target: 'tdlib',
  markdown,
  baseDir: process.cwd(),
  publish: {
    apiId: Number(process.env.TELEGRAM_TDLIB_API_ID),
    apiHash: process.env.TELEGRAM_TDLIB_API_HASH!,
    sessionRootDir: './.md2tg/tdlib',
    sessionName: 'main-account',
    chatId: '@example_channel',
    accountTier: 'auto',
    sendRetries: 3,
  },
})

console.log(result.publish.resolvedChatId)
```

## Bot API Setup

1. Create a bot with `@BotFather`.
2. Add the bot to the target channel as an administrator.
3. Put the token in `.env` as `TELEGRAM_BOT_TOKEN` or pass `--token`.
4. Use a public channel username such as `@example_channel`, or a numeric Bot API chat ID.

For a private channel, add the bot as admin, publish a temporary post, then inspect:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

Use `channel_post.chat.id` as the Bot API chat ID.

## TDLib Setup

TDLib publishes as a Telegram user account, not as a bot.

Required environment:

```bash
TELEGRAM_TDLIB_API_ID=123456
TELEGRAM_TDLIB_API_HASH=0123456789abcdef0123456789abcdef
```

Use a profile with `target: "tdlib"` and a stable `tdlib.sessionName`. The first command that needs TDLib will run TDLib authorization in the terminal.

For private channels, the authorized account must already know the chat. Resolve its numeric ID with:

```bash
md2tg resolve-chat --query "Private Channel Title" --profile account-main
```

TDLib currently publishes local media files and local attachments. Remote URL media and Bot API file IDs are rejected explicitly for TDLib publishing.

## Diagnostics

Parsing and planning return structured diagnostics:

```ts
type Diagnostic = {
  level: 'error' | 'warning'
  code: string
  message: string
}
```

The high-level publishing API throws when diagnostics contain errors. Low-level APIs return diagnostics so callers can render their own validation UI.
