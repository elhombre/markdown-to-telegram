import type { PublishCapabilities } from '../core/index.js'

import {
  closeTdlibClient,
  createLoggedInTdlibClient,
  getRuntimeSnapshot,
} from './client.js'
import type {
  TdlibAccountTier,
  TdlibCapabilityConfig,
  TdlibCapabilityResolution,
  TdlibResolvedAccountTier,
  TdlibRuntimeSnapshot,
  TdlibWarning,
} from './types.js'

export async function resolveTdlibCapabilities(config: TdlibCapabilityConfig): Promise<TdlibCapabilityResolution> {
  const client = await createLoggedInTdlibClient(config)

  try {
    const runtime = await getRuntimeSnapshot(client)
    return resolveCapabilitiesFromRuntime(config.accountTier ?? 'auto', runtime)
  } finally {
    await closeTdlibClient(client)
  }
}

export function resolveCapabilitiesFromRuntime(
  requestedTier: TdlibAccountTier,
  runtime: TdlibRuntimeSnapshot,
): TdlibCapabilityResolution {
  const warnings: TdlibWarning[] = []
  const accountIsPremium = runtime.accountIsPremium
  const currentCaptionMatchesStandard =
    runtime.standardCaptionLimit !== undefined && runtime.currentCaptionLimit === runtime.standardCaptionLimit
  const currentCaptionMatchesPremium =
    runtime.premiumCaptionLimit !== undefined && runtime.currentCaptionLimit === runtime.premiumCaptionLimit

  let accountTierResolved: TdlibResolvedAccountTier
  let captionLimit: number

  switch (requestedTier) {
    case 'standard': {
      captionLimit = resolveStandardCaptionLimit(runtime)
      accountTierResolved = 'standard'
      if (accountIsPremium === true) {
        warnings.push({
          code: 'TDLIB_ACCOUNT_TIER_CLAMPED_TO_STANDARD',
          message: 'Profile forces standard limits even though the authorized TDLib account appears to be Premium.',
        })
      }
      break
    }
    case 'premium': {
      if (accountIsPremium !== true) {
        throw new Error(
          'Profile requests accountTier="premium", but TDLib could not confirm that the authorized account is Premium.',
        )
      }
      captionLimit = resolvePremiumCaptionLimit(runtime)
      accountTierResolved = 'premium'
      break
    }
    case 'auto':
    default: {
      if (accountIsPremium === true && (currentCaptionMatchesPremium || runtime.premiumCaptionLimit === undefined)) {
        captionLimit = resolvePremiumCaptionLimit(runtime)
        accountTierResolved = 'premium'
        break
      }

      if (accountIsPremium === false && (currentCaptionMatchesStandard || runtime.standardCaptionLimit === undefined)) {
        captionLimit = resolveStandardCaptionLimit(runtime)
        accountTierResolved = 'standard'
        break
      }

      warnings.push({
        code: 'TDLIB_ACCOUNT_TIER_FALLBACK_STANDARD',
        message:
          'TDLib account tier could not be determined reliably. Falling back to safe standard caption limits for planning and publishing.',
      })
      captionLimit = resolveStandardCaptionLimit(runtime)
      accountTierResolved = 'standard'
      break
    }
  }

  const capabilities: PublishCapabilities = {
    target: 'tdlib',
    messageLimit: runtime.messageLimit,
    captionLimit,
    mediaGroupMinItems: 2,
    mediaGroupMaxItems: 10,
    supportsReply: true,
  }

  return {
    capabilities,
    accountTierRequested: requestedTier,
    accountTierResolved,
    accountIsPremium,
    warnings,
  }
}

function resolveStandardCaptionLimit(runtime: TdlibRuntimeSnapshot): number {
  if (runtime.standardCaptionLimit !== undefined) {
    return runtime.standardCaptionLimit
  }

  if (runtime.accountIsPremium === false) {
    return runtime.currentCaptionLimit
  }

  throw new Error('Unable to derive a safe standard TDLib caption limit for accountTier fallback.')
}

function resolvePremiumCaptionLimit(runtime: TdlibRuntimeSnapshot): number {
  if (runtime.premiumCaptionLimit !== undefined) {
    return runtime.premiumCaptionLimit
  }

  if (runtime.accountIsPremium === true) {
    return runtime.currentCaptionLimit
  }

  throw new Error('Unable to derive a Premium TDLib caption limit for accountTier="premium".')
}
