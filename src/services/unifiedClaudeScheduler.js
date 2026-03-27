const claudeAccountService = require('./claudeAccountService')
const claudeConsoleAccountService = require('./claudeConsoleAccountService')
const accountGroupService = require('./accountGroupService')
const redis = require('../models/redis')
const logger = require('../utils/logger')

class UnifiedClaudeScheduler {
  constructor() {
    this.SESSION_MAPPING_PREFIX = 'unified_claude_session_mapping:'
    this.ACCOUNT_COOLDOWN_PREFIX = 'unified_claude_account_cooldown:'
  }

  _isSchedulable(schedulable) {
    if (schedulable === undefined || schedulable === null) {
      return true
    }
    return schedulable !== false && schedulable !== 'false'
  }

  _getAccountCooldownKey(accountId, accountType) {
    return `${this.ACCOUNT_COOLDOWN_PREFIX}${accountType}:${accountId}`
  }

  _getDefaultCooldownSeconds() {
    const seconds = Number.parseInt(process.env.UNIFIED_CLAUDE_ACCOUNT_COOLDOWN_SECONDS, 10)
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 60
  }

  async isAccountTemporarilyUnavailable(accountId, accountType) {
    try {
      const client = redis.getClientSafe()
      const ttl = await client.ttl(this._getAccountCooldownKey(accountId, accountType))
      return ttl !== -2
    } catch (error) {
      logger.warn(
        `⚠️ Failed to check account cooldown: ${accountId} (${accountType})`,
        error.message
      )
      return false
    }
  }

  async markAccountTemporarilyUnavailable(
    accountId,
    accountType,
    sessionHash = null,
    ttlSeconds = null,
    reason = null
  ) {
    const client = redis.getClientSafe()
    const ttl =
      Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : this._getDefaultCooldownSeconds()

    await client.setex(
      this._getAccountCooldownKey(accountId, accountType),
      ttl,
      JSON.stringify({
        reason: reason || 'temporarily_unavailable',
        accountId,
        accountType,
        createdAt: new Date().toISOString()
      })
    )

    if (sessionHash) {
      await this._deleteSessionMapping(sessionHash)
    }

    logger.warn(`🚫 Account temporarily unavailable: ${accountId} (${accountType})`, {
      ttlSeconds: ttl,
      reason: reason || 'temporarily_unavailable',
      ...(sessionHash ? { sessionHash } : {})
    })

    return { success: true, ttlSeconds: ttl }
  }

  _officialAccountSupportsModel(account, requestedModel) {
    if (!requestedModel || !requestedModel.toLowerCase().includes('opus')) {
      return true
    }

    if (!account.subscriptionInfo) {
      return true
    }

    try {
      const info =
        typeof account.subscriptionInfo === 'string'
          ? JSON.parse(account.subscriptionInfo)
          : account.subscriptionInfo

      if (info.hasClaudePro === true && info.hasClaudeMax !== true) {
        logger.info(`🚫 Claude account ${account.name} (Pro) does not support Opus model`)
        return false
      }

      if (info.accountType === 'claude_pro' || info.accountType === 'claude_free') {
        logger.info(
          `🚫 Claude account ${account.name} (${info.accountType}) does not support Opus model`
        )
        return false
      }
    } catch (error) {
      logger.debug(`Account ${account.name} has invalid subscriptionInfo, assuming Max support`)
    }

    return true
  }

  _consoleAccountSupportsModel(account, requestedModel) {
    if (!requestedModel || !account.supportedModels) {
      return true
    }

    if (Array.isArray(account.supportedModels)) {
      return account.supportedModels.length === 0 || account.supportedModels.includes(requestedModel)
    }

    if (typeof account.supportedModels === 'object') {
      return claudeConsoleAccountService.isModelSupported(account.supportedModels, requestedModel)
    }

    return true
  }

  async selectAccountForApiKey(apiKeyData, sessionHash = null, requestedModel = null) {
    try {
      if (apiKeyData.claudeAccountId) {
        if (apiKeyData.claudeAccountId.startsWith('group:')) {
          const groupId = apiKeyData.claudeAccountId.replace('group:', '')
          logger.info(`🎯 API key ${apiKeyData.name} is bound to group ${groupId}`)
          return await this.selectAccountFromGroup(groupId, sessionHash, requestedModel)
        }

        const boundAccount = await redis.getClaudeAccount(apiKeyData.claudeAccountId)
        if (
          boundAccount &&
          boundAccount.isActive === 'true' &&
          boundAccount.status !== 'error' &&
          boundAccount.status !== 'blocked' &&
          this._isSchedulable(boundAccount.schedulable) &&
          this._officialAccountSupportsModel(boundAccount, requestedModel) &&
          !(await claudeAccountService.isAccountRateLimited(boundAccount.id))
        ) {
          logger.info(
            `🎯 Using bound Claude OAuth account: ${boundAccount.name} (${apiKeyData.claudeAccountId})`
          )
          return { accountId: apiKeyData.claudeAccountId, accountType: 'claude-official' }
        }

        logger.warn(
          `⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is not available, falling back to pool`
        )
      }

      if (apiKeyData.claudeConsoleAccountId) {
        const boundConsoleAccount = await claudeConsoleAccountService.getAccount(
          apiKeyData.claudeConsoleAccountId
        )
        if (
          boundConsoleAccount &&
          boundConsoleAccount.isActive === true &&
          boundConsoleAccount.status === 'active' &&
          this._isSchedulable(boundConsoleAccount.schedulable) &&
          this._consoleAccountSupportsModel(boundConsoleAccount, requestedModel) &&
          !(await claudeConsoleAccountService.isAccountRateLimited(boundConsoleAccount.id))
        ) {
          logger.info(
            `🎯 Using bound Claude Console account: ${boundConsoleAccount.name} (${apiKeyData.claudeConsoleAccountId})`
          )
          return { accountId: apiKeyData.claudeConsoleAccountId, accountType: 'claude-console' }
        }

        logger.warn(
          `⚠️ Bound Claude Console account ${apiKeyData.claudeConsoleAccountId} is not available, falling back to pool`
        )
      }

      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          const isAvailable = await this._isAccountAvailable(
            mappedAccount.accountId,
            mappedAccount.accountType,
            requestedModel
          )

          if (isAvailable) {
            logger.info(
              `🎯 Using sticky session account: ${mappedAccount.accountId} (${mappedAccount.accountType}) for session ${sessionHash}`
            )
            return mappedAccount
          }

          logger.warn(
            `⚠️ Sticky session account ${mappedAccount.accountId} is no longer available, selecting a new account`
          )
          await this._deleteSessionMapping(sessionHash)
        }
      }

      const availableAccounts = await this._getAllAvailableAccounts(requestedModel)
      if (availableAccounts.length === 0) {
        if (requestedModel) {
          throw new Error(`No available Claude accounts support the requested model: ${requestedModel}`)
        }
        throw new Error('No available Claude accounts')
      }

      const selectedAccount = this._sortAccountsByPriority(availableAccounts)[0]

      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
      }

      logger.info(
        `🎯 Selected account: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType})`
      )

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error('❌ Failed to select account for API key:', error)
      throw error
    }
  }

  async _getAllAvailableAccounts(requestedModel = null) {
    const availableAccounts = []

    const claudeAccounts = await redis.getAllClaudeAccounts()
    for (const account of claudeAccounts) {
      if (
        account.isActive === 'true' &&
        account.status !== 'error' &&
        account.status !== 'blocked' &&
        (account.accountType === 'shared' || !account.accountType) &&
        this._isSchedulable(account.schedulable) &&
        this._officialAccountSupportsModel(account, requestedModel)
      ) {
        const isRateLimited = await claudeAccountService.isAccountRateLimited(account.id)
        if (!isRateLimited) {
          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'claude-official',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
        }
      }
    }

    const consoleAccounts = await claudeConsoleAccountService.getAllAccounts()
    for (const account of consoleAccounts) {
      if (
        account.isActive === true &&
        account.status === 'active' &&
        account.accountType === 'shared' &&
        this._isSchedulable(account.schedulable) &&
        this._consoleAccountSupportsModel(account, requestedModel)
      ) {
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(account.id)
        if (!isRateLimited) {
          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'claude-console',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
        }
      }
    }

    logger.info(
      `📊 Total available accounts: ${availableAccounts.length} (Claude: ${availableAccounts.filter((a) => a.accountType === 'claude-official').length}, Console: ${availableAccounts.filter((a) => a.accountType === 'claude-console').length})`
    )

    return availableAccounts
  }

  _sortAccountsByPriority(accounts) {
    return accounts.sort((a, b) => {
      if (a.priority !== b.priority) {
        return a.priority - b.priority
      }

      const aLastUsed = new Date(a.lastUsedAt || 0).getTime()
      const bLastUsed = new Date(b.lastUsedAt || 0).getTime()
      return aLastUsed - bLastUsed
    })
  }

  async _isAccountAvailable(accountId, accountType, requestedModel = null) {
    try {
      if (accountType === 'claude-official') {
        const account = await redis.getClaudeAccount(accountId)
        if (!account || account.isActive !== 'true' || account.status === 'error' || account.status === 'blocked') {
          return false
        }
        if (!this._isSchedulable(account.schedulable)) {
          return false
        }
        if (!this._officialAccountSupportsModel(account, requestedModel)) {
          return false
        }
        return !(await claudeAccountService.isAccountRateLimited(accountId))
      }

      if (accountType === 'claude-console') {
        const account = await claudeConsoleAccountService.getAccount(accountId)
        if (!account || account.isActive !== true || account.status !== 'active') {
          return false
        }
        if (!this._isSchedulable(account.schedulable)) {
          return false
        }
        if (!this._consoleAccountSupportsModel(account, requestedModel)) {
          return false
        }
        return !(await claudeConsoleAccountService.isAccountRateLimited(accountId))
      }

      return false
    } catch (error) {
      logger.warn(`⚠️ Failed to check account availability: ${accountId}`, error.message)
      return false
    }
  }

  async _getSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    const mappingData = await client.get(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)

    if (!mappingData) {
      return null
    }

    try {
      return JSON.parse(mappingData)
    } catch (error) {
      logger.warn('⚠️ Failed to parse session mapping:', error)
      return null
    }
  }

  async _setSessionMapping(sessionHash, accountId, accountType) {
    const client = redis.getClientSafe()
    await client.setex(
      `${this.SESSION_MAPPING_PREFIX}${sessionHash}`,
      3600,
      JSON.stringify({ accountId, accountType })
    )
  }

  async _deleteSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    await client.del(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)
  }

  async markAccountRateLimited(
    accountId,
    accountType,
    sessionHash = null,
    rateLimitResetTimestamp = null
  ) {
    try {
      if (accountType === 'claude-official') {
        await claudeAccountService.markAccountRateLimited(
          accountId,
          sessionHash,
          rateLimitResetTimestamp
        )
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.markAccountRateLimited(accountId)
      }

      if (sessionHash) {
        await this._deleteSessionMapping(sessionHash)
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to mark account as rate limited: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  async removeAccountRateLimit(accountId, accountType) {
    try {
      if (accountType === 'claude-official') {
        await claudeAccountService.removeAccountRateLimit(accountId)
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.removeAccountRateLimit(accountId)
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to remove rate limit for account: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  async isAccountRateLimited(accountId, accountType) {
    try {
      if (accountType === 'claude-official') {
        return await claudeAccountService.isAccountRateLimited(accountId)
      }
      if (accountType === 'claude-console') {
        return await claudeConsoleAccountService.isAccountRateLimited(accountId)
      }
      return false
    } catch (error) {
      logger.error(`❌ Failed to check rate limit status: ${accountId} (${accountType})`, error)
      return false
    }
  }

  async markAccountUnauthorized(accountId, accountType, sessionHash = null) {
    try {
      if (accountType === 'claude-official') {
        await claudeAccountService.markAccountUnauthorized(accountId, sessionHash)
        if (sessionHash) {
          await this._deleteSessionMapping(sessionHash)
        }
      } else {
        logger.info(
          `ℹ️ Skipping unauthorized marking for non-Claude OAuth account: ${accountId} (${accountType})`
        )
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to mark account as unauthorized: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  async blockConsoleAccount(accountId, reason) {
    try {
      await claudeConsoleAccountService.blockAccount(accountId, reason)
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to block console account: ${accountId}`, error)
      throw error
    }
  }

  async selectAccountFromGroup(groupId, sessionHash = null, requestedModel = null) {
    try {
      const group = await accountGroupService.getGroup(groupId)
      if (!group) {
        throw new Error(`Group ${groupId} not found`)
      }

      if (group.platform !== 'claude') {
        throw new Error(`Unsupported group platform in clean distribution: ${group.platform}`)
      }

      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          const memberIds = await accountGroupService.getGroupMembers(groupId)
          if (memberIds.includes(mappedAccount.accountId)) {
            const isAvailable = await this._isAccountAvailable(
              mappedAccount.accountId,
              mappedAccount.accountType,
              requestedModel
            )
            if (isAvailable) {
              return mappedAccount
            }
          }
          await this._deleteSessionMapping(sessionHash)
        }
      }

      const memberIds = await accountGroupService.getGroupMembers(groupId)
      if (memberIds.length === 0) {
        throw new Error(`Group ${group.name} has no members`)
      }

      const availableAccounts = []
      for (const memberId of memberIds) {
        let account = await redis.getClaudeAccount(memberId)
        let accountType = account?.id ? 'claude-official' : null

        if (!accountType) {
          account = await claudeConsoleAccountService.getAccount(memberId)
          if (account) {
            accountType = 'claude-console'
          }
        }

        if (!account || !accountType) {
          logger.warn(`⚠️ Account ${memberId} not found in group ${group.name}`)
          continue
        }

        const isAvailable = await this._isAccountAvailable(account.id, accountType, requestedModel)
        if (!isAvailable) {
          continue
        }

        availableAccounts.push({
          ...account,
          accountId: account.id,
          accountType,
          priority: parseInt(account.priority) || 50,
          lastUsedAt: account.lastUsedAt || '0'
        })
      }

      if (availableAccounts.length === 0) {
        throw new Error(`No available accounts in group ${group.name}`)
      }

      const selectedAccount = this._sortAccountsByPriority(availableAccounts)[0]
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
      }

      logger.info(
        `🎯 Selected account from group ${group.name}: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType})`
      )

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error(`❌ Failed to select account from group ${groupId}:`, error)
      throw error
    }
  }
}

module.exports = new UnifiedClaudeScheduler()
