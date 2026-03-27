const express = require('express')
const apiKeyService = require('../services/apiKeyService')
const claudeAccountService = require('../services/claudeAccountService')
const claudeConsoleAccountService = require('../services/claudeConsoleAccountService')
const accountGroupService = require('../services/accountGroupService')
const redis = require('../models/redis')
const { authenticateAdmin } = require('../middleware/auth')
const logger = require('../utils/logger')
const oauthHelper = require('../utils/oauthHelper')
const CostCalculator = require('../utils/costCalculator')
const pricingService = require('../services/pricingService')
const claudeCodeHeadersService = require('../services/claudeCodeHeadersService')
const webhookNotifier = require('../utils/webhookNotifier')
const axios = require('axios')
const fs = require('fs')
const path = require('path')
const config = require('../../config/config')

const router = express.Router()

function sendDisabledFeatureResponse(res, featureName) {
  return res.status(410).json({
    success: false,
    error: 'Disabled in clean distribution',
    message: `${featureName} support is not included in this clean distribution`
  })
}

function sendDisabledAccountList(res, featureName) {
  return res.json({
    success: true,
    data: [],
    disabled: true,
    message: `${featureName} support is not included in this clean distribution`
  })
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getRequestOrigin(req) {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http'
  return `${protocol}://${req.get('host')}`
}

function getRemoteBrowserConfig() {
  return {
    internalUrl: (process.env.RBS_INTERNAL_URL || 'http://127.0.0.1:3199').replace(/\/+$/, ''),
    adminToken: process.env.RBS_ADMIN_TOKEN || '',
    sessionTtlSeconds: Math.max(
      60,
      Math.min(parseInt(process.env.RBS_SESSION_TTL_SECONDS || '900', 10) || 900, 3600)
    )
  }
}

function isRemoteBrowserEnabled() {
  const cfg = getRemoteBrowserConfig()
  return Boolean(cfg.adminToken)
}

async function getValidSetupTokenSessionOrThrow(sessionId, { autoDeleteExpired = true } = {}) {
  const oauthSession = await redis.getOAuthSession(sessionId)
  if (!oauthSession || Object.keys(oauthSession).length === 0) {
    throw new Error('Invalid or expired OAuth session')
  }

  if (oauthSession.type !== 'setup-token') {
    throw new Error('Invalid session type for setup token flow')
  }

  if (new Date() > new Date(oauthSession.expiresAt)) {
    if (autoDeleteExpired) {
      await redis.deleteOAuthSession(sessionId)
    }
    throw new Error('OAuth session has expired, please generate a new authorization URL')
  }

  if (!oauthSession.authUrl) {
    throw new Error('Missing setup token authorization URL in session')
  }

  return oauthSession
}

function getSetupTokenLaunchUrl(req, sessionId) {
  const origin = getRequestOrigin(req)
  return `${origin}/admin/claude-accounts/setup-token-launch?sessionId=${encodeURIComponent(
    sessionId
  )}`
}

function renderSetupTokenLaunchPage({
  sessionId,
  directAuthUrl,
  remoteEnabled,
  remoteLaunchUrl,
  expiresAt
}) {
  const escapedDirect = escapeHtml(directAuthUrl)
  const escapedRemote = escapeHtml(remoteLaunchUrl)
  const escapedSession = escapeHtml(sessionId)
  const escapedExpires = escapeHtml(new Date(expiresAt).toLocaleString('zh-CN'))

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Claude Setup Token 授权入口</title>
  <style>
    body { margin: 0; padding: 24px; font-family: -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background:#f6f8fb; color:#0f172a; }
    .card { max-width: 760px; margin: 0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px; box-shadow:0 8px 24px rgba(15,23,42,.06); }
    h1 { font-size: 20px; margin: 0 0 12px; }
    .meta { font-size: 13px; color: #475569; margin-bottom: 16px; }
    .buttons { display:flex; gap:12px; flex-wrap:wrap; margin: 16px 0; }
    .btn { display:inline-block; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:600; border:1px solid #cbd5e1; color:#0f172a; background:#fff; }
    .btn.primary { background:#2563eb; color:#fff; border-color:#2563eb; }
    .btn.disabled { pointer-events:none; opacity:.45; }
    .box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-top: 14px; }
    code { word-break:break-all; font-size: 12px; color:#334155; }
    .warn { color:#b45309; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Claude Setup Token 授权入口</h1>
    <div class="meta">Session: <code>${escapedSession}</code><br/>过期时间: ${escapedExpires}</div>

    <div class="buttons">
      <a class="btn primary" href="${escapedDirect}" target="_blank" rel="noopener noreferrer">直接授权（默认）</a>
      <a class="btn ${remoteEnabled ? '' : 'disabled'}" href="${escapedRemote}" ${remoteEnabled ? 'target="_blank" rel="noopener noreferrer"' : ''}>远程浏览器授权（可选）</a>
    </div>

    <div class="box">
      <strong>说明</strong>
      <div style="margin-top:8px; line-height:1.6;">
        1. 直接授权：与你现在流程完全一致。<br/>
        2. 远程浏览器授权：浏览器运行在服务器侧，适合本地网络受限场景。<br/>
        3. 授权后仍需把 Authorization Code 粘贴回管理界面。
      </div>
    </div>

    ${
      remoteEnabled
        ? ''
        : '<p class="warn" style="margin-top:14px;">远程浏览器功能未启用（缺少 RBS_ADMIN_TOKEN 配置），可继续使用“直接授权”。</p>'
    }

    <div class="box">
      <strong>直接授权链接</strong>
      <div style="margin-top:8px;"><code>${escapedDirect}</code></div>
    </div>
  </div>
</body>
</html>`
}

function renderRemoteBrowserReadyPage({ browserUrl, username, password, expiresAt }) {
  const escapedUrl = escapeHtml(browserUrl)
  const escapedUser = escapeHtml(username || '')
  const escapedPass = escapeHtml(password || '')
  const escapedExpires = escapeHtml(new Date(expiresAt).toLocaleString('zh-CN'))

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>远程浏览器已创建</title>
  <style>
    body { margin:0; padding:24px; font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif; background:#f6f8fb; color:#0f172a; }
    .card { max-width:760px; margin:0 auto; background:#fff; border:1px solid #e2e8f0; border-radius:12px; padding:20px; box-shadow:0 8px 24px rgba(15,23,42,.06); }
    h1 { font-size: 20px; margin: 0 0 14px; }
    .btn { display:inline-block; margin-top:10px; padding:10px 14px; border-radius:10px; text-decoration:none; font-weight:600; border:1px solid #2563eb; background:#2563eb; color:#fff; }
    .box { background:#f8fafc; border:1px solid #e2e8f0; border-radius:10px; padding:12px; margin-top: 14px; }
    code { word-break:break-all; font-size: 12px; color:#334155; }
  </style>
</head>
<body>
  <div class="card">
    <h1>远程浏览器会话已创建</h1>
    <div>请先保存登录信息，再打开远程浏览器链接。</div>

    <div class="box">
      <strong>登录信息</strong><br/>
      用户名: <code>${escapedUser}</code><br/>
      密码: <code>${escapedPass}</code><br/>
      过期时间: ${escapedExpires}
    </div>

    <div class="box">
      <strong>远程浏览器链接</strong><br/>
      <code>${escapedUrl}</code><br/>
      <a class="btn" href="${escapedUrl}" target="_blank" rel="noopener noreferrer">打开远程浏览器</a>
    </div>
  </div>
</body>
</html>`
}

// 🔑 API Keys 管理

// 调试：获取API Key费用详情
router.get('/api-keys/:keyId/cost-debug', authenticateAdmin, async (req, res) => {
  try {
    const { keyId } = req.params
    const costStats = await redis.getCostStats(keyId)
    const dailyCost = await redis.getDailyCost(keyId)
    const today = redis.getDateStringInTimezone()
    const client = redis.getClientSafe()

    // 获取所有相关的Redis键
    const costKeys = await client.keys(`usage:cost:*:${keyId}:*`)
    const keyValues = {}

    for (const key of costKeys) {
      keyValues[key] = await client.get(key)
    }

    return res.json({
      keyId,
      today,
      dailyCost,
      costStats,
      redisKeys: keyValues,
      timezone: config.system.timezoneOffset || 8
    })
  } catch (error) {
    logger.error('❌ Failed to get cost debug info:', error)
    return res.status(500).json({ error: 'Failed to get cost debug info', message: error.message })
  }
})

// 获取所有API Keys
router.get('/api-keys', authenticateAdmin, async (req, res) => {
  try {
    const { timeRange = 'all' } = req.query // all, 7days, monthly
    const apiKeys = await apiKeyService.getAllApiKeys()

    // 根据时间范围计算查询模式
    const now = new Date()
    const searchPatterns = []

    if (timeRange === 'today') {
      // 今日 - 使用时区日期
      const redisClient = require('../models/redis')
      const tzDate = redisClient.getDateInTimezone(now)
      const dateStr = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tzDate.getUTCDate()).padStart(2, '0')}`
      searchPatterns.push(`usage:daily:*:${dateStr}`)
    } else if (timeRange === '7days') {
      // 最近7天
      const redisClient = require('../models/redis')
      for (let i = 0; i < 7; i++) {
        const date = new Date(now)
        date.setDate(date.getDate() - i)
        const tzDate = redisClient.getDateInTimezone(date)
        const dateStr = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(tzDate.getUTCDate()).padStart(2, '0')}`
        searchPatterns.push(`usage:daily:*:${dateStr}`)
      }
    } else if (timeRange === 'monthly') {
      // 本月
      const redisClient = require('../models/redis')
      const tzDate = redisClient.getDateInTimezone(now)
      const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`
      searchPatterns.push(`usage:monthly:*:${currentMonth}`)
    }

    // 为每个API Key计算准确的费用和统计数据
    for (const apiKey of apiKeys) {
      const client = redis.getClientSafe()

      if (timeRange === 'all') {
        // 全部时间：保持原有逻辑
        if (apiKey.usage && apiKey.usage.total) {
          // 使用与展开模型统计相同的数据源
          // 获取所有时间的模型统计数据
          const monthlyKeys = await client.keys(`usage:${apiKey.id}:model:monthly:*:*`)
          const modelStatsMap = new Map()

          // 汇总所有月份的数据
          for (const key of monthlyKeys) {
            const match = key.match(/usage:.+:model:monthly:(.+):\d{4}-\d{2}$/)
            if (!match) {
              continue
            }

            const model = match[1]
            const data = await client.hgetall(key)

            if (data && Object.keys(data).length > 0) {
              if (!modelStatsMap.has(model)) {
                modelStatsMap.set(model, {
                  inputTokens: 0,
                  outputTokens: 0,
                  cacheCreateTokens: 0,
                  cacheReadTokens: 0
                })
              }

              const stats = modelStatsMap.get(model)
              stats.inputTokens +=
                parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0
              stats.outputTokens +=
                parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0
              stats.cacheCreateTokens +=
                parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0
              stats.cacheReadTokens +=
                parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
            }
          }

          let totalCost = 0

          // 计算每个模型的费用
          for (const [model, stats] of modelStatsMap) {
            const usage = {
              input_tokens: stats.inputTokens,
              output_tokens: stats.outputTokens,
              cache_creation_input_tokens: stats.cacheCreateTokens,
              cache_read_input_tokens: stats.cacheReadTokens
            }

            const costResult = CostCalculator.calculateCost(usage, model)
            totalCost += costResult.costs.total
          }

          // 如果没有详细的模型数据，使用总量数据和默认模型计算
          if (modelStatsMap.size === 0) {
            const usage = {
              input_tokens: apiKey.usage.total.inputTokens || 0,
              output_tokens: apiKey.usage.total.outputTokens || 0,
              cache_creation_input_tokens: apiKey.usage.total.cacheCreateTokens || 0,
              cache_read_input_tokens: apiKey.usage.total.cacheReadTokens || 0
            }

            const costResult = CostCalculator.calculateCost(usage, 'claude-3-5-haiku-20241022')
            totalCost = costResult.costs.total
          }

          // 添加格式化的费用到响应数据
          apiKey.usage.total.cost = totalCost
          apiKey.usage.total.formattedCost = CostCalculator.formatCost(totalCost)
        }
      } else {
        // 7天或本月：重新计算统计数据
        const tempUsage = {
          requests: 0,
          tokens: 0,
          allTokens: 0, // 添加allTokens字段
          inputTokens: 0,
          outputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0
        }

        // 获取指定时间范围的统计数据
        for (const pattern of searchPatterns) {
          const keys = await client.keys(pattern.replace('*', apiKey.id))

          for (const key of keys) {
            const data = await client.hgetall(key)
            if (data && Object.keys(data).length > 0) {
              // 使用与 redis.js incrementTokenUsage 中相同的字段名
              tempUsage.requests += parseInt(data.totalRequests) || parseInt(data.requests) || 0
              tempUsage.tokens += parseInt(data.totalTokens) || parseInt(data.tokens) || 0
              tempUsage.allTokens += parseInt(data.totalAllTokens) || parseInt(data.allTokens) || 0 // 读取包含所有Token的字段
              tempUsage.inputTokens +=
                parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0
              tempUsage.outputTokens +=
                parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0
              tempUsage.cacheCreateTokens +=
                parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0
              tempUsage.cacheReadTokens +=
                parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
            }
          }
        }

        // 计算指定时间范围的费用
        let totalCost = 0
        const redisClient = require('../models/redis')
        const tzToday = redisClient.getDateStringInTimezone(now)
        const tzDate = redisClient.getDateInTimezone(now)
        const tzMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`

        const modelKeys =
          timeRange === 'today'
            ? await client.keys(`usage:${apiKey.id}:model:daily:*:${tzToday}`)
            : timeRange === '7days'
              ? await client.keys(`usage:${apiKey.id}:model:daily:*:*`)
              : await client.keys(`usage:${apiKey.id}:model:monthly:*:${tzMonth}`)

        const modelStatsMap = new Map()

        // 过滤和汇总相应时间范围的模型数据
        for (const key of modelKeys) {
          if (timeRange === '7days') {
            // 检查是否在最近7天内
            const dateMatch = key.match(/\d{4}-\d{2}-\d{2}$/)
            if (dateMatch) {
              const keyDate = new Date(dateMatch[0])
              const daysDiff = Math.floor((now - keyDate) / (1000 * 60 * 60 * 24))
              if (daysDiff > 6) {
                continue
              }
            }
          } else if (timeRange === 'today') {
            // today选项已经在查询时过滤了，不需要额外处理
          }

          const modelMatch = key.match(
            /usage:.+:model:(?:daily|monthly):(.+):\d{4}-\d{2}(?:-\d{2})?$/
          )
          if (!modelMatch) {
            continue
          }

          const model = modelMatch[1]
          const data = await client.hgetall(key)

          if (data && Object.keys(data).length > 0) {
            if (!modelStatsMap.has(model)) {
              modelStatsMap.set(model, {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0
              })
            }

            const stats = modelStatsMap.get(model)
            stats.inputTokens += parseInt(data.totalInputTokens) || parseInt(data.inputTokens) || 0
            stats.outputTokens +=
              parseInt(data.totalOutputTokens) || parseInt(data.outputTokens) || 0
            stats.cacheCreateTokens +=
              parseInt(data.totalCacheCreateTokens) || parseInt(data.cacheCreateTokens) || 0
            stats.cacheReadTokens +=
              parseInt(data.totalCacheReadTokens) || parseInt(data.cacheReadTokens) || 0
          }
        }

        // 计算费用
        for (const [model, stats] of modelStatsMap) {
          const usage = {
            input_tokens: stats.inputTokens,
            output_tokens: stats.outputTokens,
            cache_creation_input_tokens: stats.cacheCreateTokens,
            cache_read_input_tokens: stats.cacheReadTokens
          }

          const costResult = CostCalculator.calculateCost(usage, model)
          totalCost += costResult.costs.total
        }

        // 如果没有模型数据，使用临时统计数据计算
        if (modelStatsMap.size === 0 && tempUsage.tokens > 0) {
          const usage = {
            input_tokens: tempUsage.inputTokens,
            output_tokens: tempUsage.outputTokens,
            cache_creation_input_tokens: tempUsage.cacheCreateTokens,
            cache_read_input_tokens: tempUsage.cacheReadTokens
          }

          const costResult = CostCalculator.calculateCost(usage, 'claude-3-5-haiku-20241022')
          totalCost = costResult.costs.total
        }

        // 使用从Redis读取的allTokens，如果没有则计算
        const allTokens =
          tempUsage.allTokens ||
          tempUsage.inputTokens +
            tempUsage.outputTokens +
            tempUsage.cacheCreateTokens +
            tempUsage.cacheReadTokens

        // 更新API Key的usage数据为指定时间范围的数据
        apiKey.usage[timeRange] = {
          ...tempUsage,
          tokens: allTokens, // 使用包含所有Token的总数
          allTokens,
          cost: totalCost,
          formattedCost: CostCalculator.formatCost(totalCost)
        }

        // 为了保持兼容性，也更新total字段
        apiKey.usage.total = apiKey.usage[timeRange]
      }
    }

    return res.json({ success: true, data: apiKeys })
  } catch (error) {
    logger.error('❌ Failed to get API keys:', error)
    return res.status(500).json({ error: 'Failed to get API keys', message: error.message })
  }
})

// 获取支持的客户端列表
router.get('/supported-clients', authenticateAdmin, async (req, res) => {
  try {
    const predefinedClients = config.clientRestrictions?.predefinedClients || [
      {
        id: 'claude_code',
        name: 'ClaudeCode',
        description: 'Official Claude Code CLI'
      }
    ]

    const clients = predefinedClients
      .filter((client) => client.id === 'claude_code')
      .map((client) => ({
        id: client.id,
        name: client.name,
        description: client.description
      }))

    return res.json({ success: true, data: clients })
  } catch (error) {
    logger.error('❌ Failed to get supported clients:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get supported clients', message: error.message })
  }
})

// 获取已存在的标签列表
router.get('/api-keys/tags', authenticateAdmin, async (req, res) => {
  try {
    const apiKeys = await apiKeyService.getAllApiKeys()
    const tagSet = new Set()

    // 收集所有API Keys的标签
    for (const apiKey of apiKeys) {
      if (apiKey.tags && Array.isArray(apiKey.tags)) {
        apiKey.tags.forEach((tag) => {
          if (tag && tag.trim()) {
            tagSet.add(tag.trim())
          }
        })
      }
    }

    // 转换为数组并排序
    const tags = Array.from(tagSet).sort()

    logger.info(`📋 Retrieved ${tags.length} unique tags from API keys`)
    return res.json({ success: true, data: tags })
  } catch (error) {
    logger.error('❌ Failed to get API key tags:', error)
    return res.status(500).json({ error: 'Failed to get API key tags', message: error.message })
  }
})

// 创建新的API Key
router.post('/api-keys', authenticateAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      tokenLimit,
      expiresAt,
      claudeAccountId,
      claudeConsoleAccountId,
      permissions,
      concurrencyLimit,
      rateLimitWindow,
      rateLimitRequests,
      enableModelRestriction,
      restrictedModels,
      enableClientRestriction,
      allowedClients,
      dailyCostLimit,
      tags
    } = req.body

    // 输入验证
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ error: 'Name is required and must be a non-empty string' })
    }

    if (name.length > 100) {
      return res.status(400).json({ error: 'Name must be less than 100 characters' })
    }

    if (description && (typeof description !== 'string' || description.length > 500)) {
      return res
        .status(400)
        .json({ error: 'Description must be a string with less than 500 characters' })
    }

    if (tokenLimit && (!Number.isInteger(Number(tokenLimit)) || Number(tokenLimit) < 0)) {
      return res.status(400).json({ error: 'Token limit must be a non-negative integer' })
    }

    if (
      concurrencyLimit !== undefined &&
      concurrencyLimit !== null &&
      concurrencyLimit !== '' &&
      (!Number.isInteger(Number(concurrencyLimit)) || Number(concurrencyLimit) < 0)
    ) {
      return res.status(400).json({ error: 'Concurrency limit must be a non-negative integer' })
    }

    if (
      rateLimitWindow !== undefined &&
      rateLimitWindow !== null &&
      rateLimitWindow !== '' &&
      (!Number.isInteger(Number(rateLimitWindow)) || Number(rateLimitWindow) < 1)
    ) {
      return res
        .status(400)
        .json({ error: 'Rate limit window must be a positive integer (minutes)' })
    }

    if (
      rateLimitRequests !== undefined &&
      rateLimitRequests !== null &&
      rateLimitRequests !== '' &&
      (!Number.isInteger(Number(rateLimitRequests)) || Number(rateLimitRequests) < 1)
    ) {
      return res.status(400).json({ error: 'Rate limit requests must be a positive integer' })
    }

    // 验证模型限制字段
    if (enableModelRestriction !== undefined && typeof enableModelRestriction !== 'boolean') {
      return res.status(400).json({ error: 'Enable model restriction must be a boolean' })
    }

    if (restrictedModels !== undefined && !Array.isArray(restrictedModels)) {
      return res.status(400).json({ error: 'Restricted models must be an array' })
    }

    // 验证客户端限制字段
    if (enableClientRestriction !== undefined && typeof enableClientRestriction !== 'boolean') {
      return res.status(400).json({ error: 'Enable client restriction must be a boolean' })
    }

    if (allowedClients !== undefined && !Array.isArray(allowedClients)) {
      return res.status(400).json({ error: 'Allowed clients must be an array' })
    }

    // 验证标签字段
    if (tags !== undefined && !Array.isArray(tags)) {
      return res.status(400).json({ error: 'Tags must be an array' })
    }

    if (tags && tags.some((tag) => typeof tag !== 'string' || tag.trim().length === 0)) {
      return res.status(400).json({ error: 'All tags must be non-empty strings' })
    }

    if (permissions !== undefined && !['claude', 'all'].includes(permissions)) {
      return res.status(400).json({ error: 'Invalid permissions value. Must be claude or all' })
    }

    const newKey = await apiKeyService.generateApiKey({
      name,
      description,
      tokenLimit,
      expiresAt,
      claudeAccountId,
      claudeConsoleAccountId,
      permissions,
      concurrencyLimit,
      rateLimitWindow,
      rateLimitRequests,
      enableModelRestriction,
      restrictedModels,
      enableClientRestriction,
      allowedClients,
      dailyCostLimit,
      tags
    })

    logger.success(`🔑 Admin created new API key: ${name}`)
    return res.json({ success: true, data: newKey })
  } catch (error) {
    logger.error('❌ Failed to create API key:', error)
    return res.status(500).json({ error: 'Failed to create API key', message: error.message })
  }
})

// 批量创建API Keys
router.post('/api-keys/batch', authenticateAdmin, async (req, res) => {
  try {
    const {
      baseName,
      count,
      description,
      tokenLimit,
      expiresAt,
      claudeAccountId,
      claudeConsoleAccountId,
      permissions,
      concurrencyLimit,
      rateLimitWindow,
      rateLimitRequests,
      enableModelRestriction,
      restrictedModels,
      enableClientRestriction,
      allowedClients,
      dailyCostLimit,
      tags
    } = req.body

    // 输入验证
    if (!baseName || typeof baseName !== 'string' || baseName.trim().length === 0) {
      return res.status(400).json({ error: 'Base name is required and must be a non-empty string' })
    }

    if (!count || !Number.isInteger(count) || count < 2 || count > 500) {
      return res.status(400).json({ error: 'Count must be an integer between 2 and 500' })
    }

    if (baseName.length > 90) {
      return res
        .status(400)
        .json({ error: 'Base name must be less than 90 characters to allow for numbering' })
    }

    if (permissions !== undefined && !['claude', 'all'].includes(permissions)) {
      return res.status(400).json({ error: 'Invalid permissions value. Must be claude or all' })
    }

    // 生成批量API Keys
    const createdKeys = []
    const errors = []

    for (let i = 1; i <= count; i++) {
      try {
        const name = `${baseName}_${i}`
        const newKey = await apiKeyService.generateApiKey({
          name,
          description,
          tokenLimit,
          expiresAt,
          claudeAccountId,
          claudeConsoleAccountId,
          permissions,
          concurrencyLimit,
          rateLimitWindow,
          rateLimitRequests,
          enableModelRestriction,
          restrictedModels,
          enableClientRestriction,
          allowedClients,
          dailyCostLimit,
          tags
        })

        // 保留原始 API Key 供返回
        createdKeys.push({
          ...newKey,
          apiKey: newKey.apiKey
        })
      } catch (error) {
        errors.push({
          index: i,
          name: `${baseName}_${i}`,
          error: error.message
        })
      }
    }

    // 如果有部分失败，返回部分成功的结果
    if (errors.length > 0 && createdKeys.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Failed to create any API keys',
        errors
      })
    }

    // 返回创建的keys（包含完整的apiKey）
    return res.json({
      success: true,
      data: createdKeys,
      errors: errors.length > 0 ? errors : undefined,
      summary: {
        requested: count,
        created: createdKeys.length,
        failed: errors.length
      }
    })
  } catch (error) {
    logger.error('Failed to batch create API keys:', error)
    return res.status(500).json({
      success: false,
      error: 'Failed to batch create API keys',
      message: error.message
    })
  }
})

// 批量编辑API Keys
router.put('/api-keys/batch', authenticateAdmin, async (req, res) => {
  try {
    const { keyIds, updates } = req.body

    if (!keyIds || !Array.isArray(keyIds) || keyIds.length === 0) {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'keyIds must be a non-empty array'
      })
    }

    if (!updates || typeof updates !== 'object') {
      return res.status(400).json({
        error: 'Invalid input',
        message: 'updates must be an object'
      })
    }

    logger.info(
      `🔄 Admin batch editing ${keyIds.length} API keys with updates: ${JSON.stringify(updates)}`
    )
    logger.info(`🔍 Debug: keyIds received: ${JSON.stringify(keyIds)}`)

    const results = {
      successCount: 0,
      failedCount: 0,
      errors: []
    }

    // 处理每个API Key
    for (const keyId of keyIds) {
      try {
        // 获取当前API Key信息
        const currentKey = await redis.getApiKey(keyId)
        if (!currentKey || Object.keys(currentKey).length === 0) {
          results.failedCount++
          results.errors.push(`API key ${keyId} not found`)
          continue
        }

        // 构建最终更新数据
        const finalUpdates = {}

        // 处理普通字段
        if (updates.name) {
          finalUpdates.name = updates.name
        }
        if (updates.tokenLimit !== undefined) {
          finalUpdates.tokenLimit = updates.tokenLimit
        }
        if (updates.concurrencyLimit !== undefined) {
          finalUpdates.concurrencyLimit = updates.concurrencyLimit
        }
        if (updates.rateLimitWindow !== undefined) {
          finalUpdates.rateLimitWindow = updates.rateLimitWindow
        }
        if (updates.rateLimitRequests !== undefined) {
          finalUpdates.rateLimitRequests = updates.rateLimitRequests
        }
        if (updates.dailyCostLimit !== undefined) {
          finalUpdates.dailyCostLimit = updates.dailyCostLimit
        }
        if (updates.permissions !== undefined) {
          finalUpdates.permissions = updates.permissions
        }
        if (updates.isActive !== undefined) {
          finalUpdates.isActive = updates.isActive
        }
        if (updates.monthlyLimit !== undefined) {
          finalUpdates.monthlyLimit = updates.monthlyLimit
        }
        if (updates.priority !== undefined) {
          finalUpdates.priority = updates.priority
        }
        if (updates.enabled !== undefined) {
          finalUpdates.enabled = updates.enabled
        }

        // 处理账户绑定
        if (updates.claudeAccountId !== undefined) {
          finalUpdates.claudeAccountId = updates.claudeAccountId
        }
        if (updates.claudeConsoleAccountId !== undefined) {
          finalUpdates.claudeConsoleAccountId = updates.claudeConsoleAccountId
        }
        if (updates.permissions !== undefined && !['claude', 'all'].includes(updates.permissions)) {
          throw new Error('Invalid permissions value. Must be claude or all')
        }

        // 处理标签操作
        if (updates.tags !== undefined) {
          if (updates.tagOperation) {
            const currentTags = currentKey.tags ? JSON.parse(currentKey.tags) : []
            const operationTags = updates.tags

            switch (updates.tagOperation) {
              case 'replace': {
                finalUpdates.tags = operationTags
                break
              }
              case 'add': {
                const newTags = [...currentTags]
                operationTags.forEach((tag) => {
                  if (!newTags.includes(tag)) {
                    newTags.push(tag)
                  }
                })
                finalUpdates.tags = newTags
                break
              }
              case 'remove': {
                finalUpdates.tags = currentTags.filter((tag) => !operationTags.includes(tag))
                break
              }
            }
          } else {
            // 如果没有指定操作类型，默认为替换
            finalUpdates.tags = updates.tags
          }
        }

        // 执行更新
        await apiKeyService.updateApiKey(keyId, finalUpdates)
        results.successCount++
        logger.success(`✅ Batch edit: API key ${keyId} updated successfully`)
      } catch (error) {
        results.failedCount++
        results.errors.push(`Failed to update key ${keyId}: ${error.message}`)
        logger.error(`❌ Batch edit failed for key ${keyId}:`, error)
      }
    }

    // 记录批量编辑结果
    if (results.successCount > 0) {
      logger.success(
        `🎉 Batch edit completed: ${results.successCount} successful, ${results.failedCount} failed`
      )
    } else {
      logger.warn(
        `⚠️ Batch edit completed with no successful updates: ${results.failedCount} failed`
      )
    }

    return res.json({
      success: true,
      message: `批量编辑完成`,
      data: results
    })
  } catch (error) {
    logger.error('❌ Failed to batch edit API keys:', error)
    return res.status(500).json({
      error: 'Batch edit failed',
      message: error.message
    })
  }
})

// 更新API Key
router.put('/api-keys/:keyId', authenticateAdmin, async (req, res) => {
  try {
    const { keyId } = req.params
    const {
      tokenLimit,
      concurrencyLimit,
      rateLimitWindow,
      rateLimitRequests,
      isActive,
      claudeAccountId,
      claudeConsoleAccountId,
      permissions,
      enableModelRestriction,
      restrictedModels,
      enableClientRestriction,
      allowedClients,
      expiresAt,
      dailyCostLimit,
      tags
    } = req.body

    // 只允许更新指定字段
    const updates = {}

    if (tokenLimit !== undefined && tokenLimit !== null && tokenLimit !== '') {
      if (!Number.isInteger(Number(tokenLimit)) || Number(tokenLimit) < 0) {
        return res.status(400).json({ error: 'Token limit must be a non-negative integer' })
      }
      updates.tokenLimit = Number(tokenLimit)
    }

    if (concurrencyLimit !== undefined && concurrencyLimit !== null && concurrencyLimit !== '') {
      if (!Number.isInteger(Number(concurrencyLimit)) || Number(concurrencyLimit) < 0) {
        return res.status(400).json({ error: 'Concurrency limit must be a non-negative integer' })
      }
      updates.concurrencyLimit = Number(concurrencyLimit)
    }

    if (rateLimitWindow !== undefined && rateLimitWindow !== null && rateLimitWindow !== '') {
      if (!Number.isInteger(Number(rateLimitWindow)) || Number(rateLimitWindow) < 0) {
        return res
          .status(400)
          .json({ error: 'Rate limit window must be a non-negative integer (minutes)' })
      }
      updates.rateLimitWindow = Number(rateLimitWindow)
    }

    if (rateLimitRequests !== undefined && rateLimitRequests !== null && rateLimitRequests !== '') {
      if (!Number.isInteger(Number(rateLimitRequests)) || Number(rateLimitRequests) < 0) {
        return res.status(400).json({ error: 'Rate limit requests must be a non-negative integer' })
      }
      updates.rateLimitRequests = Number(rateLimitRequests)
    }

    if (claudeAccountId !== undefined) {
      // 空字符串表示解绑，null或空字符串都设置为空字符串
      updates.claudeAccountId = claudeAccountId || ''
    }

    if (claudeConsoleAccountId !== undefined) {
      // 空字符串表示解绑，null或空字符串都设置为空字符串
      updates.claudeConsoleAccountId = claudeConsoleAccountId || ''
    }

    if (permissions !== undefined) {
      // 验证权限值
      if (!['claude', 'all'].includes(permissions)) {
        return res.status(400).json({ error: 'Invalid permissions value. Must be claude or all' })
      }
      updates.permissions = permissions
    }

    // 处理模型限制字段
    if (enableModelRestriction !== undefined) {
      if (typeof enableModelRestriction !== 'boolean') {
        return res.status(400).json({ error: 'Enable model restriction must be a boolean' })
      }
      updates.enableModelRestriction = enableModelRestriction
    }

    if (restrictedModels !== undefined) {
      if (!Array.isArray(restrictedModels)) {
        return res.status(400).json({ error: 'Restricted models must be an array' })
      }
      updates.restrictedModels = restrictedModels
    }

    // 处理客户端限制字段
    if (enableClientRestriction !== undefined) {
      if (typeof enableClientRestriction !== 'boolean') {
        return res.status(400).json({ error: 'Enable client restriction must be a boolean' })
      }
      updates.enableClientRestriction = enableClientRestriction
    }

    if (allowedClients !== undefined) {
      if (!Array.isArray(allowedClients)) {
        return res.status(400).json({ error: 'Allowed clients must be an array' })
      }
      updates.allowedClients = allowedClients
    }

    // 处理过期时间字段
    if (expiresAt !== undefined) {
      if (expiresAt === null) {
        // null 表示永不过期
        updates.expiresAt = null
        updates.isActive = true
      } else {
        // 验证日期格式
        const expireDate = new Date(expiresAt)
        if (isNaN(expireDate.getTime())) {
          return res.status(400).json({ error: 'Invalid expiration date format' })
        }
        updates.expiresAt = expiresAt
        updates.isActive = expireDate > new Date() // 如果过期时间在当前时间之后，则设置为激活状态
      }
    }

    // 处理每日费用限制
    if (dailyCostLimit !== undefined && dailyCostLimit !== null && dailyCostLimit !== '') {
      const costLimit = Number(dailyCostLimit)
      if (isNaN(costLimit) || costLimit < 0) {
        return res.status(400).json({ error: 'Daily cost limit must be a non-negative number' })
      }
      updates.dailyCostLimit = costLimit
    }

    // 处理标签
    if (tags !== undefined) {
      if (!Array.isArray(tags)) {
        return res.status(400).json({ error: 'Tags must be an array' })
      }
      if (tags.some((tag) => typeof tag !== 'string' || tag.trim().length === 0)) {
        return res.status(400).json({ error: 'All tags must be non-empty strings' })
      }
      updates.tags = tags
    }

    // 处理活跃/禁用状态状态, 放在过期处理后，以确保后续增加禁用key功能
    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        return res.status(400).json({ error: 'isActive must be a boolean' })
      }
      updates.isActive = isActive
    }

    await apiKeyService.updateApiKey(keyId, updates)

    logger.success(`📝 Admin updated API key: ${keyId}`)
    return res.json({ success: true, message: 'API key updated successfully' })
  } catch (error) {
    logger.error('❌ Failed to update API key:', error)
    return res.status(500).json({ error: 'Failed to update API key', message: error.message })
  }
})

// 批量删除API Keys（必须在 :keyId 路由之前定义）
router.delete('/api-keys/batch', authenticateAdmin, async (req, res) => {
  try {
    const { keyIds } = req.body

    // 调试信息
    logger.info(`🐛 Batch delete request body: ${JSON.stringify(req.body)}`)
    logger.info(`🐛 keyIds type: ${typeof keyIds}, value: ${JSON.stringify(keyIds)}`)

    // 参数验证
    if (!keyIds || !Array.isArray(keyIds) || keyIds.length === 0) {
      logger.warn(
        `🚨 Invalid keyIds: ${JSON.stringify({ keyIds, type: typeof keyIds, isArray: Array.isArray(keyIds) })}`
      )
      return res.status(400).json({
        error: 'Invalid request',
        message: 'keyIds 必须是一个非空数组'
      })
    }

    if (keyIds.length > 100) {
      return res.status(400).json({
        error: 'Too many keys',
        message: '每次最多只能删除100个API Keys'
      })
    }

    // 验证keyIds格式
    const invalidKeys = keyIds.filter((id) => !id || typeof id !== 'string')
    if (invalidKeys.length > 0) {
      return res.status(400).json({
        error: 'Invalid key IDs',
        message: '包含无效的API Key ID'
      })
    }

    logger.info(
      `🗑️ Admin attempting batch delete of ${keyIds.length} API keys: ${JSON.stringify(keyIds)}`
    )

    const results = {
      successCount: 0,
      failedCount: 0,
      errors: []
    }

    // 逐个删除，记录成功和失败情况
    for (const keyId of keyIds) {
      try {
        // 检查API Key是否存在
        const apiKey = await redis.getApiKey(keyId)
        if (!apiKey || Object.keys(apiKey).length === 0) {
          results.failedCount++
          results.errors.push({ keyId, error: 'API Key 不存在' })
          continue
        }

        // 执行删除
        await apiKeyService.deleteApiKey(keyId)
        results.successCount++

        logger.success(`✅ Batch delete: API key ${keyId} deleted successfully`)
      } catch (error) {
        results.failedCount++
        results.errors.push({
          keyId,
          error: error.message || '删除失败'
        })

        logger.error(`❌ Batch delete failed for key ${keyId}:`, error)
      }
    }

    // 记录批量删除结果
    if (results.successCount > 0) {
      logger.success(
        `🎉 Batch delete completed: ${results.successCount} successful, ${results.failedCount} failed`
      )
    } else {
      logger.warn(
        `⚠️ Batch delete completed with no successful deletions: ${results.failedCount} failed`
      )
    }

    return res.json({
      success: true,
      message: `批量删除完成`,
      data: results
    })
  } catch (error) {
    logger.error('❌ Failed to batch delete API keys:', error)
    return res.status(500).json({
      error: 'Batch delete failed',
      message: error.message
    })
  }
})

// 删除单个API Key（必须在批量删除路由之后定义）
router.delete('/api-keys/:keyId', authenticateAdmin, async (req, res) => {
  try {
    const { keyId } = req.params

    await apiKeyService.deleteApiKey(keyId)

    logger.success(`🗑️ Admin deleted API key: ${keyId}`)
    return res.json({ success: true, message: 'API key deleted successfully' })
  } catch (error) {
    logger.error('❌ Failed to delete API key:', error)
    return res.status(500).json({ error: 'Failed to delete API key', message: error.message })
  }
})

// 👥 账户分组管理

// 创建账户分组
router.post('/account-groups', authenticateAdmin, async (req, res) => {
  try {
    const { name, platform, description } = req.body

    const group = await accountGroupService.createGroup({
      name,
      platform,
      description
    })

    return res.json({ success: true, data: group })
  } catch (error) {
    logger.error('❌ Failed to create account group:', error)
    return res.status(400).json({ error: error.message })
  }
})

// 获取所有分组
router.get('/account-groups', authenticateAdmin, async (req, res) => {
  try {
    const { platform } = req.query
    const groups = await accountGroupService.getAllGroups(platform)
    return res.json({ success: true, data: groups })
  } catch (error) {
    logger.error('❌ Failed to get account groups:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 获取分组详情
router.get('/account-groups/:groupId', authenticateAdmin, async (req, res) => {
  try {
    const { groupId } = req.params
    const group = await accountGroupService.getGroup(groupId)

    if (!group) {
      return res.status(404).json({ error: '分组不存在' })
    }

    return res.json({ success: true, data: group })
  } catch (error) {
    logger.error('❌ Failed to get account group:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 更新分组
router.put('/account-groups/:groupId', authenticateAdmin, async (req, res) => {
  try {
    const { groupId } = req.params
    const updates = req.body

    const updatedGroup = await accountGroupService.updateGroup(groupId, updates)
    return res.json({ success: true, data: updatedGroup })
  } catch (error) {
    logger.error('❌ Failed to update account group:', error)
    return res.status(400).json({ error: error.message })
  }
})

// 删除分组
router.delete('/account-groups/:groupId', authenticateAdmin, async (req, res) => {
  try {
    const { groupId } = req.params
    await accountGroupService.deleteGroup(groupId)
    return res.json({ success: true, message: '分组删除成功' })
  } catch (error) {
    logger.error('❌ Failed to delete account group:', error)
    return res.status(400).json({ error: error.message })
  }
})

// 获取分组成员
router.get('/account-groups/:groupId/members', authenticateAdmin, async (req, res) => {
  try {
    const { groupId } = req.params
    const memberIds = await accountGroupService.getGroupMembers(groupId)

    const members = []
    for (const memberId of memberIds) {
      let account = await claudeAccountService.getAccount(memberId)
      if (!account) {
        account = await claudeConsoleAccountService.getAccount(memberId)
      }

      if (account) {
        members.push(account)
      }
    }

    return res.json({ success: true, data: members })
  } catch (error) {
    logger.error('❌ Failed to get group members:', error)
    return res.status(500).json({ error: error.message })
  }
})

// 🏢 Claude 账户管理

// 生成OAuth授权URL
router.post('/claude-accounts/generate-auth-url', authenticateAdmin, async (req, res) => {
  try {
    const { proxy } = req.body // 接收代理配置
    const oauthParams = await oauthHelper.generateOAuthParams()

    // 将codeVerifier和state临时存储到Redis，用于后续验证
    const sessionId = require('crypto').randomUUID()
    await redis.setOAuthSession(sessionId, {
      codeVerifier: oauthParams.codeVerifier,
      state: oauthParams.state,
      codeChallenge: oauthParams.codeChallenge,
      proxy: proxy || null, // 存储代理配置
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10分钟过期
    })

    logger.success('🔗 Generated OAuth authorization URL with proxy support')
    return res.json({
      success: true,
      data: {
        authUrl: oauthParams.authUrl,
        sessionId,
        instructions: [
          '1. 复制上面的链接到浏览器中打开',
          '2. 登录您的 Anthropic 账户',
          '3. 同意应用权限',
          '4. 复制浏览器地址栏中的完整 URL',
          '5. 在添加账户表单中粘贴完整的回调 URL 和授权码'
        ]
      }
    })
  } catch (error) {
    logger.error('❌ Failed to generate OAuth URL:', error)
    return res.status(500).json({ error: 'Failed to generate OAuth URL', message: error.message })
  }
})

// 验证授权码并获取token
router.post('/claude-accounts/exchange-code', authenticateAdmin, async (req, res) => {
  try {
    const { sessionId, authorizationCode, callbackUrl } = req.body

    if (!sessionId || (!authorizationCode && !callbackUrl)) {
      return res
        .status(400)
        .json({ error: 'Session ID and authorization code (or callback URL) are required' })
    }

    // 从Redis获取OAuth会话信息
    const oauthSession = await redis.getOAuthSession(sessionId)
    if (!oauthSession) {
      return res.status(400).json({ error: 'Invalid or expired OAuth session' })
    }

    // 检查会话是否过期
    if (new Date() > new Date(oauthSession.expiresAt)) {
      await redis.deleteOAuthSession(sessionId)
      return res
        .status(400)
        .json({ error: 'OAuth session has expired, please generate a new authorization URL' })
    }

    // 统一处理授权码输入（可能是直接的code或完整的回调URL）
    let finalAuthCode
    const inputValue = callbackUrl || authorizationCode

    try {
      finalAuthCode = oauthHelper.parseCallbackUrl(inputValue)
    } catch (parseError) {
      return res
        .status(400)
        .json({ error: 'Failed to parse authorization input', message: parseError.message })
    }

    // 交换访问令牌
    const tokenData = await oauthHelper.exchangeCodeForTokens(
      finalAuthCode,
      oauthSession.codeVerifier,
      oauthSession.state,
      oauthSession.proxy // 传递代理配置
    )

    // 清理OAuth会话
    await redis.deleteOAuthSession(sessionId)

    logger.success('🎉 Successfully exchanged authorization code for tokens')
    return res.json({
      success: true,
      data: {
        claudeAiOauth: tokenData
      }
    })
  } catch (error) {
    logger.error('❌ Failed to exchange authorization code:', {
      error: error.message,
      sessionId: req.body.sessionId,
      // 不记录完整的授权码，只记录长度和前几个字符
      codeLength: req.body.callbackUrl
        ? req.body.callbackUrl.length
        : req.body.authorizationCode
          ? req.body.authorizationCode.length
          : 0,
      codePrefix: req.body.callbackUrl
        ? `${req.body.callbackUrl.substring(0, 10)}...`
        : req.body.authorizationCode
          ? `${req.body.authorizationCode.substring(0, 10)}...`
          : 'N/A'
    })
    return res
      .status(500)
      .json({ error: 'Failed to exchange authorization code', message: error.message })
  }
})

// 生成Claude setup-token授权URL
router.post('/claude-accounts/generate-setup-token-url', authenticateAdmin, async (req, res) => {
  try {
    const { proxy } = req.body // 接收代理配置
    const setupTokenParams = await oauthHelper.generateSetupTokenParams()

    // 将codeVerifier和state临时存储到Redis，用于后续验证
    const sessionId = require('crypto').randomUUID()
    await redis.setOAuthSession(sessionId, {
      type: 'setup-token', // 标记为setup-token类型
      codeVerifier: setupTokenParams.codeVerifier,
      state: setupTokenParams.state,
      codeChallenge: setupTokenParams.codeChallenge,
      authUrl: setupTokenParams.authUrl,
      proxy: proxy || null, // 存储代理配置
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10分钟过期
    })

    const launchUrl = getSetupTokenLaunchUrl(req, sessionId)

    logger.success('🔗 Generated Setup Token authorization URL with proxy support')
    return res.json({
      success: true,
      data: {
        authUrl: launchUrl,
        directAuthUrl: setupTokenParams.authUrl,
        launchUrl,
        remoteBrowserEnabled: isRemoteBrowserEnabled(),
        sessionId,
        instructions: [
          '1. 打开上面的链接（会进入授权入口页）',
          '2. 可选择“直接授权”或“远程浏览器授权（可选）”',
          '3. 登录 Claude 并完成授权',
          '4. 复制 Authorization Code 并粘贴回当前表单'
        ]
      }
    })
  } catch (error) {
    logger.error('❌ Failed to generate Setup Token URL:', error)
    return res
      .status(500)
      .json({ error: 'Failed to generate Setup Token URL', message: error.message })
  }
})

// Setup Token 授权入口（直接授权/远程浏览器授权）
// 不需要 authenticateAdmin：sessionId 本身是加密随机 UUID，10分钟过期，由 getValidSetupTokenSessionOrThrow 验证
router.get('/claude-accounts/setup-token-launch', async (req, res) => {
  try {
    const { sessionId } = req.query
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).send('Missing sessionId')
    }

    const oauthSession = await getValidSetupTokenSessionOrThrow(sessionId, {
      autoDeleteExpired: true
    })

    const directAuthUrl = oauthSession.authUrl
    const remoteLaunchUrl = `${getRequestOrigin(
      req
    )}/admin/claude-accounts/setup-token-launch/remote?sessionId=${encodeURIComponent(sessionId)}`

    return res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(
        renderSetupTokenLaunchPage({
          sessionId,
          directAuthUrl,
          remoteEnabled: isRemoteBrowserEnabled(),
          remoteLaunchUrl,
          expiresAt: oauthSession.expiresAt
        })
      )
  } catch (error) {
    logger.error('❌ Failed to render setup token launch page:', error.message)
    return res.status(400).send(escapeHtml(error.message))
  }
})

// 远程浏览器授权（可选）- 创建远程浏览器会话并返回会话页面
// 同上：sessionId 即认证，浏览器直接打开不带 Bearer header
router.get('/claude-accounts/setup-token-launch/remote', async (req, res) => {
  try {
    const { sessionId } = req.query
    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).send('Missing sessionId')
    }

    const oauthSession = await getValidSetupTokenSessionOrThrow(sessionId, {
      autoDeleteExpired: false
    })

    if (!isRemoteBrowserEnabled()) {
      return res.status(503).send('Remote browser is not enabled on server')
    }

    const remoteCfg = getRemoteBrowserConfig()
    const sidecarApiUrl = `${remoteCfg.internalUrl}/api/sessions`

    let sidecarResponse
    try {
      sidecarResponse = await axios.post(
        sidecarApiUrl,
        {
          startUrl: oauthSession.authUrl,
          ttlSeconds: remoteCfg.sessionTtlSeconds
        },
        {
          timeout: 20000,
          headers: {
            'x-rbs-admin-token': remoteCfg.adminToken
          }
        }
      )
    } catch (sidecarError) {
      const status = sidecarError.response?.status
      const detail = sidecarError.response?.data || sidecarError.message
      logger.error('❌ Failed to create remote browser session via sidecar', {
        status,
        detail
      })
      return res
        .status(502)
        .send(`Remote browser sidecar unavailable: ${escapeHtml(JSON.stringify(detail))}`)
    }

    const sessionData = sidecarResponse?.data?.data
    if (!sessionData || !sessionData.browserUrl) {
      return res.status(502).send('Invalid sidecar response: missing browserUrl')
    }

    logger.info('✅ Remote browser session created for setup token launch', {
      sessionId,
      sidecarSessionId: sessionData.id
    })

    return res
      .status(200)
      .setHeader('Content-Type', 'text/html; charset=utf-8')
      .send(
        renderRemoteBrowserReadyPage({
          browserUrl: sessionData.browserUrl,
          username: sessionData.username,
          password: sessionData.password,
          expiresAt: sessionData.expiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString()
        })
      )
  } catch (error) {
    logger.error('❌ Failed to handle remote setup token launch:', error.message)
    return res.status(400).send(escapeHtml(error.message))
  }
})

// 验证setup-token授权码并获取token
router.post('/claude-accounts/exchange-setup-token-code', authenticateAdmin, async (req, res) => {
  try {
    const { sessionId, authorizationCode, callbackUrl } = req.body

    if (!sessionId || (!authorizationCode && !callbackUrl)) {
      return res
        .status(400)
        .json({ error: 'Session ID and authorization code (or callback URL) are required' })
    }

    // 从Redis获取OAuth会话信息
    const oauthSession = await redis.getOAuthSession(sessionId)
    if (!oauthSession) {
      return res.status(400).json({ error: 'Invalid or expired OAuth session' })
    }

    // 检查是否是setup-token类型
    if (oauthSession.type !== 'setup-token') {
      return res.status(400).json({ error: 'Invalid session type for setup token exchange' })
    }

    // 检查会话是否过期
    if (new Date() > new Date(oauthSession.expiresAt)) {
      await redis.deleteOAuthSession(sessionId)
      return res
        .status(400)
        .json({ error: 'OAuth session has expired, please generate a new authorization URL' })
    }

    // 统一处理授权码输入（可能是直接的code或完整的回调URL）
    let finalAuthCode
    const inputValue = callbackUrl || authorizationCode

    try {
      finalAuthCode = oauthHelper.parseCallbackUrl(inputValue)
    } catch (parseError) {
      return res
        .status(400)
        .json({ error: 'Failed to parse authorization input', message: parseError.message })
    }

    // 交换Setup Token
    const tokenData = await oauthHelper.exchangeSetupTokenCode(
      finalAuthCode,
      oauthSession.codeVerifier,
      oauthSession.state,
      oauthSession.proxy // 传递代理配置
    )

    // 清理OAuth会话
    await redis.deleteOAuthSession(sessionId)

    logger.success('🎉 Successfully exchanged setup token authorization code for tokens')
    return res.json({
      success: true,
      data: {
        claudeAiOauth: tokenData
      }
    })
  } catch (error) {
    logger.error('❌ Failed to exchange setup token authorization code:', {
      error: error.message,
      sessionId: req.body.sessionId,
      // 不记录完整的授权码，只记录长度和前几个字符
      codeLength: req.body.callbackUrl
        ? req.body.callbackUrl.length
        : req.body.authorizationCode
          ? req.body.authorizationCode.length
          : 0,
      codePrefix: req.body.callbackUrl
        ? `${req.body.callbackUrl.substring(0, 10)}...`
        : req.body.authorizationCode
          ? `${req.body.authorizationCode.substring(0, 10)}...`
          : 'N/A'
    })
    return res
      .status(500)
      .json({ error: 'Failed to exchange setup token authorization code', message: error.message })
  }
})

// 获取所有Claude账户
router.get('/claude-accounts', authenticateAdmin, async (req, res) => {
  try {
    const { platform, groupId } = req.query
    let accounts = await claudeAccountService.getAllAccounts()

    // 根据查询参数进行筛选
    if (platform && platform !== 'all' && platform !== 'claude') {
      accounts = []
    }

    // 如果指定了分组筛选
    if (groupId && groupId !== 'all') {
      if (groupId === 'ungrouped') {
        // 筛选未分组账户
        accounts = accounts.filter((account) => !account.groupInfo)
      } else {
        // 筛选特定分组的账户
        accounts = accounts.filter(
          (account) => account.groupInfo && account.groupInfo.id === groupId
        )
      }
    }

    // 为每个账户添加使用统计信息
    const accountsWithStats = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usageStats = await redis.getAccountUsageStats(account.id)
          return {
            ...account,
            usage: {
              daily: usageStats.daily,
              total: usageStats.total,
              averages: usageStats.averages
            }
          }
        } catch (statsError) {
          logger.warn(`⚠️ Failed to get usage stats for account ${account.id}:`, statsError.message)
          // 如果获取统计失败，返回空统计
          return {
            ...account,
            usage: {
              daily: { tokens: 0, requests: 0, allTokens: 0 },
              total: { tokens: 0, requests: 0, allTokens: 0 },
              averages: { rpm: 0, tpm: 0 }
            }
          }
        }
      })
    )

    return res.json({ success: true, data: accountsWithStats })
  } catch (error) {
    logger.error('❌ Failed to get Claude accounts:', error)
    return res.status(500).json({ error: 'Failed to get Claude accounts', message: error.message })
  }
})

// 创建新的Claude账户
router.post('/claude-accounts', authenticateAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      email,
      password,
      refreshToken,
      claudeAiOauth,
      proxy,
      accountType,
      priority,
      groupId
    } = req.body

    if (!name) {
      return res.status(400).json({ error: 'Name is required' })
    }

    // 验证accountType的有效性
    if (accountType && !['shared', 'dedicated', 'group'].includes(accountType)) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    // 如果是分组类型，验证groupId
    if (accountType === 'group' && !groupId) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    // 验证priority的有效性
    if (
      priority !== undefined &&
      (typeof priority !== 'number' || priority < 1 || priority > 100)
    ) {
      return res.status(400).json({ error: 'Priority must be a number between 1 and 100' })
    }

    const newAccount = await claudeAccountService.createAccount({
      name,
      description,
      email,
      password,
      refreshToken,
      claudeAiOauth,
      proxy,
      accountType: accountType || 'shared', // 默认为共享类型
      platform: 'claude',
      priority: priority || 50 // 默认优先级为50
    })

    // 如果是分组类型，将账户添加到分组
    if (accountType === 'group' && groupId) {
      await accountGroupService.addAccountToGroup(newAccount.id, groupId, 'claude')
    }

    logger.success(`🏢 Admin created new Claude account: ${name} (${accountType || 'shared'})`)
    return res.json({ success: true, data: newAccount })
  } catch (error) {
    logger.error('❌ Failed to create Claude account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to create Claude account', message: error.message })
  }
})

// 更新Claude账户
router.put('/claude-accounts/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const updates = req.body

    // 验证priority的有效性
    if (
      updates.priority !== undefined &&
      (typeof updates.priority !== 'number' || updates.priority < 1 || updates.priority > 100)
    ) {
      return res.status(400).json({ error: 'Priority must be a number between 1 and 100' })
    }

    // 验证accountType的有效性
    if (updates.accountType && !['shared', 'dedicated', 'group'].includes(updates.accountType)) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    // 如果更新为分组类型，验证groupId
    if (updates.accountType === 'group' && !updates.groupId) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    // 获取账户当前信息以处理分组变更
    const currentAccount = await claudeAccountService.getAccount(accountId)
    if (!currentAccount) {
      return res.status(404).json({ error: 'Account not found' })
    }

    // 处理分组的变更
    if (updates.accountType !== undefined) {
      // 如果之前是分组类型，需要从原分组中移除
      if (currentAccount.accountType === 'group') {
        const oldGroup = await accountGroupService.getAccountGroup(accountId)
        if (oldGroup) {
          await accountGroupService.removeAccountFromGroup(accountId, oldGroup.id)
        }
      }

      // 如果新类型是分组，添加到新分组
      if (updates.accountType === 'group' && updates.groupId) {
        // 从路由知道这是 Claude OAuth 账户，平台为 'claude'
        await accountGroupService.addAccountToGroup(accountId, updates.groupId, 'claude')
      }
    }

    await claudeAccountService.updateAccount(accountId, { ...updates, platform: 'claude' })

    logger.success(`📝 Admin updated Claude account: ${accountId}`)
    return res.json({ success: true, message: 'Claude account updated successfully' })
  } catch (error) {
    logger.error('❌ Failed to update Claude account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to update Claude account', message: error.message })
  }
})

// 删除Claude账户
router.delete('/claude-accounts/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    // 获取账户信息以检查是否在分组中
    const account = await claudeAccountService.getAccount(accountId)
    if (account && account.accountType === 'group') {
      const group = await accountGroupService.getAccountGroup(accountId)
      if (group) {
        await accountGroupService.removeAccountFromGroup(accountId, group.id)
      }
    }

    await claudeAccountService.deleteAccount(accountId)

    logger.success(`🗑️ Admin deleted Claude account: ${accountId}`)
    return res.json({ success: true, message: 'Claude account deleted successfully' })
  } catch (error) {
    logger.error('❌ Failed to delete Claude account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to delete Claude account', message: error.message })
  }
})

// 更新单个Claude账户的Profile信息
router.post('/claude-accounts/:accountId/update-profile', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const profileInfo = await claudeAccountService.fetchAndUpdateAccountProfile(accountId)

    logger.success(`✅ Updated profile for Claude account: ${accountId}`)
    return res.json({
      success: true,
      message: 'Account profile updated successfully',
      data: profileInfo
    })
  } catch (error) {
    logger.error('❌ Failed to update account profile:', error)
    return res
      .status(500)
      .json({ error: 'Failed to update account profile', message: error.message })
  }
})

// 批量更新所有Claude账户的Profile信息
router.post('/claude-accounts/update-all-profiles', authenticateAdmin, async (req, res) => {
  try {
    const result = await claudeAccountService.updateAllAccountProfiles()

    logger.success('✅ Batch profile update completed')
    return res.json({
      success: true,
      message: 'Batch profile update completed',
      data: result
    })
  } catch (error) {
    logger.error('❌ Failed to update all account profiles:', error)
    return res
      .status(500)
      .json({ error: 'Failed to update all account profiles', message: error.message })
  }
})

// 刷新Claude账户token
router.post('/claude-accounts/:accountId/refresh', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const result = await claudeAccountService.refreshAccountToken(accountId)

    logger.success(`🔄 Admin refreshed token for Claude account: ${accountId}`)
    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('❌ Failed to refresh Claude account token:', error)
    return res.status(500).json({ error: 'Failed to refresh token', message: error.message })
  }
})

// 重置Claude账户状态（清除所有异常状态）
router.post('/claude-accounts/:accountId/reset-status', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const result = await claudeAccountService.resetAccountStatus(accountId)

    logger.success(`✅ Admin reset status for Claude account: ${accountId}`)
    return res.json({ success: true, data: result })
  } catch (error) {
    logger.error('❌ Failed to reset Claude account status:', error)
    return res.status(500).json({ error: 'Failed to reset status', message: error.message })
  }
})

// ✅ 解除Claude账户限流状态（仅清除限流标记）
router.post(
  '/claude-accounts/:accountId/remove-rate-limit',
  authenticateAdmin,
  async (req, res) => {
    try {
      const { accountId } = req.params
      const result = await claudeAccountService.removeAccountRateLimit(accountId)
      logger.success(`✅ Admin removed rate limit for Claude account: ${accountId}`)
      return res.json({ success: true, data: result })
    } catch (error) {
      logger.error('❌ Failed to remove Claude account rate limit:', error)
      return res.status(500).json({ error: 'Failed to remove rate limit', message: error.message })
    }
  }
)

// 切换Claude账户调度状态
router.put(
  '/claude-accounts/:accountId/toggle-schedulable',
  authenticateAdmin,
  async (req, res) => {
    try {
      const { accountId } = req.params

      const accounts = await claudeAccountService.getAllAccounts()
      const account = accounts.find((acc) => acc.id === accountId)

      if (!account) {
        return res.status(404).json({ error: 'Account not found' })
      }

      const newSchedulable = !account.schedulable
      await claudeAccountService.updateAccount(accountId, { schedulable: newSchedulable })

      // 如果账号被禁用，发送webhook通知
      if (!newSchedulable) {
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId: account.id,
          accountName: account.name || account.claudeAiOauth?.email || 'Claude Account',
          platform: 'claude-oauth',
          status: 'disabled',
          errorCode: 'CLAUDE_OAUTH_MANUALLY_DISABLED',
          reason: '账号已被管理员手动禁用调度',
          timestamp: new Date().toISOString()
        })
      }

      logger.success(
        `🔄 Admin toggled Claude account schedulable status: ${accountId} -> ${newSchedulable ? 'schedulable' : 'not schedulable'}`
      )
      return res.json({ success: true, schedulable: newSchedulable })
    } catch (error) {
      logger.error('❌ Failed to toggle Claude account schedulable status:', error)
      return res
        .status(500)
        .json({ error: 'Failed to toggle schedulable status', message: error.message })
    }
  }
)

// 🎮 Claude Console 账户管理

// 获取所有Claude Console账户
router.get('/claude-console-accounts', authenticateAdmin, async (req, res) => {
  try {
    const { platform, groupId } = req.query
    let accounts = await claudeConsoleAccountService.getAllAccounts()

    // 根据查询参数进行筛选
    if (platform && platform !== 'all' && platform !== 'claude-console') {
      // 如果指定了其他平台，返回空数组
      accounts = []
    }

    // 如果指定了分组筛选
    if (groupId && groupId !== 'all') {
      if (groupId === 'ungrouped') {
        // 筛选未分组账户
        accounts = accounts.filter((account) => !account.groupInfo)
      } else {
        // 筛选特定分组的账户
        accounts = accounts.filter(
          (account) => account.groupInfo && account.groupInfo.id === groupId
        )
      }
    }

    // 为每个账户添加使用统计信息
    const accountsWithStats = await Promise.all(
      accounts.map(async (account) => {
        try {
          const usageStats = await redis.getAccountUsageStats(account.id)
          return {
            ...account,
            usage: {
              daily: usageStats.daily,
              total: usageStats.total,
              averages: usageStats.averages
            }
          }
        } catch (statsError) {
          logger.warn(
            `⚠️ Failed to get usage stats for Claude Console account ${account.id}:`,
            statsError.message
          )
          return {
            ...account,
            usage: {
              daily: { tokens: 0, requests: 0, allTokens: 0 },
              total: { tokens: 0, requests: 0, allTokens: 0 },
              averages: { rpm: 0, tpm: 0 }
            }
          }
        }
      })
    )

    return res.json({ success: true, data: accountsWithStats })
  } catch (error) {
    logger.error('❌ Failed to get Claude Console accounts:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get Claude Console accounts', message: error.message })
  }
})

// 创建新的Claude Console账户
router.post('/claude-console-accounts', authenticateAdmin, async (req, res) => {
  try {
    const {
      name,
      description,
      apiUrl,
      apiKey,
      priority,
      supportedModels,
      userAgent,
      rateLimitDuration,
      proxy,
      accountType,
      groupId
    } = req.body

    if (!name || !apiUrl || !apiKey) {
      return res.status(400).json({ error: 'Name, API URL and API Key are required' })
    }

    // 验证priority的有效性（1-100）
    if (priority !== undefined && (priority < 1 || priority > 100)) {
      return res.status(400).json({ error: 'Priority must be between 1 and 100' })
    }

    // 验证accountType的有效性
    if (accountType && !['shared', 'dedicated', 'group'].includes(accountType)) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    // 如果是分组类型，验证groupId
    if (accountType === 'group' && !groupId) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    const newAccount = await claudeConsoleAccountService.createAccount({
      name,
      description,
      apiUrl,
      apiKey,
      priority: priority || 50,
      supportedModels: supportedModels || [],
      userAgent,
      rateLimitDuration:
        rateLimitDuration !== undefined && rateLimitDuration !== null ? rateLimitDuration : 60,
      proxy,
      accountType: accountType || 'shared'
    })

    // 如果是分组类型，将账户添加到分组
    if (accountType === 'group' && groupId) {
      await accountGroupService.addAccountToGroup(newAccount.id, groupId, 'claude')
    }

    logger.success(`🎮 Admin created Claude Console account: ${name}`)
    return res.json({ success: true, data: newAccount })
  } catch (error) {
    logger.error('❌ Failed to create Claude Console account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to create Claude Console account', message: error.message })
  }
})

// 更新Claude Console账户
router.put('/claude-console-accounts/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    const updates = req.body

    // 验证priority的有效性（1-100）
    if (updates.priority !== undefined && (updates.priority < 1 || updates.priority > 100)) {
      return res.status(400).json({ error: 'Priority must be between 1 and 100' })
    }

    // 验证accountType的有效性
    if (updates.accountType && !['shared', 'dedicated', 'group'].includes(updates.accountType)) {
      return res
        .status(400)
        .json({ error: 'Invalid account type. Must be "shared", "dedicated" or "group"' })
    }

    // 如果更新为分组类型，验证groupId
    if (updates.accountType === 'group' && !updates.groupId) {
      return res.status(400).json({ error: 'Group ID is required for group type accounts' })
    }

    // 获取账户当前信息以处理分组变更
    const currentAccount = await claudeConsoleAccountService.getAccount(accountId)
    if (!currentAccount) {
      return res.status(404).json({ error: 'Account not found' })
    }

    // 处理分组的变更
    if (updates.accountType !== undefined) {
      // 如果之前是分组类型，需要从原分组中移除
      if (currentAccount.accountType === 'group') {
        const oldGroup = await accountGroupService.getAccountGroup(accountId)
        if (oldGroup) {
          await accountGroupService.removeAccountFromGroup(accountId, oldGroup.id)
        }
      }
      // 如果新类型是分组，添加到新分组
      if (updates.accountType === 'group' && updates.groupId) {
        // Claude Console 账户在分组中被视为 'claude' 平台
        await accountGroupService.addAccountToGroup(accountId, updates.groupId, 'claude')
      }
    }

    await claudeConsoleAccountService.updateAccount(accountId, updates)

    logger.success(`📝 Admin updated Claude Console account: ${accountId}`)
    return res.json({ success: true, message: 'Claude Console account updated successfully' })
  } catch (error) {
    logger.error('❌ Failed to update Claude Console account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to update Claude Console account', message: error.message })
  }
})

// 删除Claude Console账户
router.delete('/claude-console-accounts/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    // 获取账户信息以检查是否在分组中
    const account = await claudeConsoleAccountService.getAccount(accountId)
    if (account && account.accountType === 'group') {
      const group = await accountGroupService.getAccountGroup(accountId)
      if (group) {
        await accountGroupService.removeAccountFromGroup(accountId, group.id)
      }
    }

    await claudeConsoleAccountService.deleteAccount(accountId)

    logger.success(`🗑️ Admin deleted Claude Console account: ${accountId}`)
    return res.json({ success: true, message: 'Claude Console account deleted successfully' })
  } catch (error) {
    logger.error('❌ Failed to delete Claude Console account:', error)
    return res
      .status(500)
      .json({ error: 'Failed to delete Claude Console account', message: error.message })
  }
})

// 切换Claude Console账户状态
router.put('/claude-console-accounts/:accountId/toggle', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params

    const account = await claudeConsoleAccountService.getAccount(accountId)
    if (!account) {
      return res.status(404).json({ error: 'Account not found' })
    }

    const newStatus = !account.isActive
    await claudeConsoleAccountService.updateAccount(accountId, { isActive: newStatus })

    logger.success(
      `🔄 Admin toggled Claude Console account status: ${accountId} -> ${newStatus ? 'active' : 'inactive'}`
    )
    return res.json({ success: true, isActive: newStatus })
  } catch (error) {
    logger.error('❌ Failed to toggle Claude Console account status:', error)
    return res
      .status(500)
      .json({ error: 'Failed to toggle account status', message: error.message })
  }
})

// 切换Claude Console账户调度状态
router.put(
  '/claude-console-accounts/:accountId/toggle-schedulable',
  authenticateAdmin,
  async (req, res) => {
    try {
      const { accountId } = req.params

      const account = await claudeConsoleAccountService.getAccount(accountId)
      if (!account) {
        return res.status(404).json({ error: 'Account not found' })
      }

      const newSchedulable = !account.schedulable
      await claudeConsoleAccountService.updateAccount(accountId, { schedulable: newSchedulable })

      // 如果账号被禁用，发送webhook通知
      if (!newSchedulable) {
        await webhookNotifier.sendAccountAnomalyNotification({
          accountId: account.id,
          accountName: account.name || 'Claude Console Account',
          platform: 'claude-console',
          status: 'disabled',
          errorCode: 'CLAUDE_CONSOLE_MANUALLY_DISABLED',
          reason: '账号已被管理员手动禁用调度',
          timestamp: new Date().toISOString()
        })
      }

      logger.success(
        `🔄 Admin toggled Claude Console account schedulable status: ${accountId} -> ${newSchedulable ? 'schedulable' : 'not schedulable'}`
      )
      return res.json({ success: true, schedulable: newSchedulable })
    } catch (error) {
      logger.error('❌ Failed to toggle Claude Console account schedulable status:', error)
      return res
        .status(500)
        .json({ error: 'Failed to toggle schedulable status', message: error.message })
    }
  }
)

// ✅ 解除Claude Console账户限流状态
router.post(
  '/claude-console-accounts/:accountId/remove-rate-limit',
  authenticateAdmin,
  async (req, res) => {
    try {
      const { accountId } = req.params
      const result = await claudeConsoleAccountService.removeAccountRateLimit(accountId)
      logger.success(`✅ Admin removed rate limit for Claude Console account: ${accountId}`)
      return res.json({ success: true, data: result })
    } catch (error) {
      logger.error('❌ Failed to remove Claude Console account rate limit:', error)
      return res.status(500).json({ error: 'Failed to remove rate limit', message: error.message })
    }
  }
)

// Disabled provider compatibility routes
router.get('/bedrock-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledAccountList(res, 'Bedrock')
)
router.post('/bedrock-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Bedrock')
)
router.put('/bedrock-accounts/:accountId', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Bedrock')
)
router.delete('/bedrock-accounts/:accountId', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Bedrock')
)
router.put('/bedrock-accounts/:accountId/toggle', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Bedrock')
)
router.put('/bedrock-accounts/:accountId/toggle-schedulable', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Bedrock')
)
router.post('/bedrock-accounts/:accountId/test', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Bedrock')
)

router.get('/gemini-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledAccountList(res, 'Gemini')
)
router.post('/gemini-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)
router.put('/gemini-accounts/:accountId', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)
router.delete('/gemini-accounts/:accountId', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)
router.post('/gemini-accounts/generate-auth-url', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)
router.post('/gemini-accounts/poll-auth-status', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)
router.post('/gemini-accounts/exchange-code', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)
router.post('/gemini-accounts/:accountId/refresh', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)
router.put('/gemini-accounts/:accountId/toggle-schedulable', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Gemini')
)

router.get('/anyrouter-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledAccountList(res, 'Anyrouter')
)
router.post('/anyrouter-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Anyrouter')
)
router.put('/anyrouter-accounts/:accountId', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Anyrouter')
)
router.delete('/anyrouter-accounts/:accountId', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Anyrouter')
)
router.put(
  '/anyrouter-accounts/:accountId/toggle-schedulable',
  authenticateAdmin,
  async (req, res) => sendDisabledFeatureResponse(res, 'Anyrouter')
)

// 📊 系统统计

// 获取系统概览
router.get('/dashboard', authenticateAdmin, async (req, res) => {
  try {
    const [
      ,
      apiKeys,
      claudeAccounts,
      claudeConsoleAccounts,
      todayStats,
      systemAverages,
      realtimeMetrics
    ] = await Promise.all([
      redis.getSystemStats(),
      apiKeyService.getAllApiKeys(),
      claudeAccountService.getAllAccounts(),
      claudeConsoleAccountService.getAllAccounts(),
      redis.getTodayStats(),
      redis.getSystemAverages(),
      redis.getRealtimeSystemMetrics()
    ])

    const totalTokensUsed = apiKeys.reduce(
      (sum, key) => sum + (key.usage?.total?.allTokens || 0),
      0
    )
    const totalRequestsUsed = apiKeys.reduce(
      (sum, key) => sum + (key.usage?.total?.requests || 0),
      0
    )
    const totalInputTokensUsed = apiKeys.reduce(
      (sum, key) => sum + (key.usage?.total?.inputTokens || 0),
      0
    )
    const totalOutputTokensUsed = apiKeys.reduce(
      (sum, key) => sum + (key.usage?.total?.outputTokens || 0),
      0
    )
    const totalCacheCreateTokensUsed = apiKeys.reduce(
      (sum, key) => sum + (key.usage?.total?.cacheCreateTokens || 0),
      0
    )
    const totalCacheReadTokensUsed = apiKeys.reduce(
      (sum, key) => sum + (key.usage?.total?.cacheReadTokens || 0),
      0
    )
    const totalAllTokensUsed = apiKeys.reduce(
      (sum, key) => sum + (key.usage?.total?.allTokens || 0),
      0
    )
    const activeApiKeys = apiKeys.filter((key) => key.isActive).length

    const normalClaudeAccounts = claudeAccounts.filter(
      (acc) =>
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized' &&
        acc.schedulable !== false &&
        !(acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited)
    ).length
    const abnormalClaudeAccounts = claudeAccounts.filter(
      (acc) => !acc.isActive || acc.status === 'blocked' || acc.status === 'unauthorized'
    ).length
    const pausedClaudeAccounts = claudeAccounts.filter(
      (acc) =>
        acc.schedulable === false &&
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized'
    ).length
    const rateLimitedClaudeAccounts = claudeAccounts.filter(
      (acc) => acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited
    ).length

    const normalClaudeConsoleAccounts = claudeConsoleAccounts.filter(
      (acc) =>
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized' &&
        acc.schedulable !== false &&
        !(acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited)
    ).length
    const abnormalClaudeConsoleAccounts = claudeConsoleAccounts.filter(
      (acc) => !acc.isActive || acc.status === 'blocked' || acc.status === 'unauthorized'
    ).length
    const pausedClaudeConsoleAccounts = claudeConsoleAccounts.filter(
      (acc) =>
        acc.schedulable === false &&
        acc.isActive &&
        acc.status !== 'blocked' &&
        acc.status !== 'unauthorized'
    ).length
    const rateLimitedClaudeConsoleAccounts = claudeConsoleAccounts.filter(
      (acc) => acc.rateLimitStatus && acc.rateLimitStatus.isRateLimited
    ).length

    const totalAccounts = claudeAccounts.length + claudeConsoleAccounts.length
    const normalAccounts = normalClaudeAccounts + normalClaudeConsoleAccounts
    const abnormalAccounts = abnormalClaudeAccounts + abnormalClaudeConsoleAccounts
    const pausedAccounts = pausedClaudeAccounts + pausedClaudeConsoleAccounts
    const rateLimitedAccounts = rateLimitedClaudeAccounts + rateLimitedClaudeConsoleAccounts

    const dashboard = {
      overview: {
        totalApiKeys: apiKeys.length,
        activeApiKeys,
        totalAccounts,
        normalAccounts,
        abnormalAccounts,
        pausedAccounts,
        rateLimitedAccounts,
        accountsByPlatform: {
          claude: {
            total: claudeAccounts.length,
            normal: normalClaudeAccounts,
            abnormal: abnormalClaudeAccounts,
            paused: pausedClaudeAccounts,
            rateLimited: rateLimitedClaudeAccounts
          },
          'claude-console': {
            total: claudeConsoleAccounts.length,
            normal: normalClaudeConsoleAccounts,
            abnormal: abnormalClaudeConsoleAccounts,
            paused: pausedClaudeConsoleAccounts,
            rateLimited: rateLimitedClaudeConsoleAccounts
          },
          gemini: { total: 0, normal: 0, abnormal: 0, paused: 0, rateLimited: 0 },
          bedrock: { total: 0, normal: 0, abnormal: 0, paused: 0, rateLimited: 0 },
          anyrouter: { total: 0, normal: 0, abnormal: 0, paused: 0, rateLimited: 0 },
          openai: { total: 0, normal: 0, abnormal: 0, paused: 0, rateLimited: 0 },
          'azure-openai': { total: 0, normal: 0, abnormal: 0, paused: 0, rateLimited: 0 }
        },
        activeAccounts: normalAccounts,
        totalClaudeAccounts: totalAccounts,
        activeClaudeAccounts: normalAccounts,
        rateLimitedClaudeAccounts: rateLimitedAccounts,
        totalGeminiAccounts: 0,
        activeGeminiAccounts: 0,
        rateLimitedGeminiAccounts: 0,
        totalTokensUsed,
        totalRequestsUsed,
        totalInputTokensUsed,
        totalOutputTokensUsed,
        totalCacheCreateTokensUsed,
        totalCacheReadTokensUsed,
        totalAllTokensUsed
      },
      recentActivity: {
        apiKeysCreatedToday: todayStats.apiKeysCreatedToday,
        requestsToday: todayStats.requestsToday,
        tokensToday: todayStats.tokensToday,
        inputTokensToday: todayStats.inputTokensToday,
        outputTokensToday: todayStats.outputTokensToday,
        cacheCreateTokensToday: todayStats.cacheCreateTokensToday || 0,
        cacheReadTokensToday: todayStats.cacheReadTokensToday || 0
      },
      systemAverages: {
        rpm: systemAverages.systemRPM,
        tpm: systemAverages.systemTPM
      },
      realtimeMetrics: {
        rpm: realtimeMetrics.realtimeRPM,
        tpm: realtimeMetrics.realtimeTPM,
        windowMinutes: realtimeMetrics.windowMinutes,
        isHistorical: realtimeMetrics.windowMinutes === 0
      },
      systemHealth: {
        redisConnected: redis.isConnected,
        claudeAccountsHealthy: normalAccounts > 0,
        geminiAccountsHealthy: false,
        uptime: process.uptime()
      },
      systemTimezone: config.system.timezoneOffset || 8
    }

    return res.json({ success: true, data: dashboard })
  } catch (error) {
    logger.error('❌ Failed to get dashboard data:', error)
    return res.status(500).json({ error: 'Failed to get dashboard data', message: error.message })
  }
})
// 获取使用统计
router.get('/usage-stats', authenticateAdmin, async (req, res) => {
  try {
    const { period = 'daily' } = req.query // daily, monthly

    // 获取基础API Key统计
    const apiKeys = await apiKeyService.getAllApiKeys()

    const stats = apiKeys.map((key) => ({
      keyId: key.id,
      keyName: key.name,
      usage: key.usage
    }))

    return res.json({ success: true, data: { period, stats } })
  } catch (error) {
    logger.error('❌ Failed to get usage stats:', error)
    return res.status(500).json({ error: 'Failed to get usage stats', message: error.message })
  }
})

// 获取按模型的使用统计和费用
router.get('/model-stats', authenticateAdmin, async (req, res) => {
  try {
    const { period = 'daily', startDate, endDate } = req.query // daily, monthly, 支持自定义时间范围
    const today = redis.getDateStringInTimezone()
    const tzDate = redis.getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`

    logger.info(
      `📊 Getting global model stats, period: ${period}, startDate: ${startDate}, endDate: ${endDate}, today: ${today}, currentMonth: ${currentMonth}`
    )

    const client = redis.getClientSafe()

    // 获取所有模型的统计数据
    let searchPatterns = []

    if (startDate && endDate) {
      // 自定义日期范围，生成多个日期的搜索模式
      const start = new Date(startDate)
      const end = new Date(endDate)

      // 确保日期范围有效
      if (start > end) {
        return res.status(400).json({ error: 'Start date must be before or equal to end date' })
      }

      // 限制最大范围为31天
      const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1
      if (daysDiff > 31) {
        return res.status(400).json({ error: 'Date range cannot exceed 31 days' })
      }

      // 生成日期范围内所有日期的搜索模式
      const currentDate = new Date(start)
      while (currentDate <= end) {
        const dateStr = redis.getDateStringInTimezone(currentDate)
        searchPatterns.push(`usage:model:daily:*:${dateStr}`)
        currentDate.setDate(currentDate.getDate() + 1)
      }

      logger.info(`📊 Generated ${searchPatterns.length} search patterns for date range`)
    } else {
      // 使用默认的period
      const pattern =
        period === 'daily'
          ? `usage:model:daily:*:${today}`
          : `usage:model:monthly:*:${currentMonth}`
      searchPatterns = [pattern]
    }

    logger.info('📊 Searching patterns:', searchPatterns)

    // 获取所有匹配的keys
    const allKeys = []
    for (const pattern of searchPatterns) {
      const keys = await client.keys(pattern)
      allKeys.push(...keys)
    }

    logger.info(`📊 Found ${allKeys.length} matching keys in total`)

    // 模型名标准化函数（与redis.js保持一致）
    const normalizeModelName = (model) => {
      if (!model || model === 'unknown') {
        return model
      }

      // 对于Bedrock模型，去掉区域前缀进行统一
      if (model.includes('.anthropic.') || model.includes('.claude')) {
        // 匹配所有AWS区域格式：region.anthropic.model-name-v1:0 -> claude-model-name
        // 支持所有AWS区域格式，如：us-east-1, eu-west-1, ap-southeast-1, ca-central-1等
        let normalized = model.replace(/^[a-z0-9-]+\./, '') // 去掉任何区域前缀（更通用）
        normalized = normalized.replace('anthropic.', '') // 去掉anthropic前缀
        normalized = normalized.replace(/-v\d+:\d+$/, '') // 去掉版本后缀（如-v1:0, -v2:1等）
        return normalized
      }

      // 对于其他模型，去掉常见的版本后缀
      return model.replace(/-v\d+:\d+$|:latest$/, '')
    }

    // 聚合相同模型的数据
    const modelStatsMap = new Map()

    for (const key of allKeys) {
      const match = key.match(/usage:model:daily:(.+):\d{4}-\d{2}-\d{2}$/)

      if (!match) {
        logger.warn(`📊 Pattern mismatch for key: ${key}`)
        continue
      }

      const rawModel = match[1]
      const normalizedModel = normalizeModelName(rawModel)
      const data = await client.hgetall(key)

      if (data && Object.keys(data).length > 0) {
        const stats = modelStatsMap.get(normalizedModel) || {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreateTokens: 0,
          cacheReadTokens: 0,
          allTokens: 0
        }

        stats.requests += parseInt(data.requests) || 0
        stats.inputTokens += parseInt(data.inputTokens) || 0
        stats.outputTokens += parseInt(data.outputTokens) || 0
        stats.cacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
        stats.cacheReadTokens += parseInt(data.cacheReadTokens) || 0
        stats.allTokens += parseInt(data.allTokens) || 0

        modelStatsMap.set(normalizedModel, stats)
      }
    }

    // 转换为数组并计算费用
    const modelStats = []

    for (const [model, stats] of modelStatsMap) {
      const usage = {
        input_tokens: stats.inputTokens,
        output_tokens: stats.outputTokens,
        cache_creation_input_tokens: stats.cacheCreateTokens,
        cache_read_input_tokens: stats.cacheReadTokens
      }

      // 计算费用
      const costData = CostCalculator.calculateCost(usage, model)

      modelStats.push({
        model,
        period: startDate && endDate ? 'custom' : period,
        requests: stats.requests,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreateTokens: usage.cache_creation_input_tokens,
        cacheReadTokens: usage.cache_read_input_tokens,
        allTokens: stats.allTokens,
        usage: {
          requests: stats.requests,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheCreateTokens: usage.cache_creation_input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          totalTokens:
            usage.input_tokens +
            usage.output_tokens +
            usage.cache_creation_input_tokens +
            usage.cache_read_input_tokens
        },
        costs: costData.costs,
        formatted: costData.formatted,
        pricing: costData.pricing
      })
    }

    // 按总费用排序
    modelStats.sort((a, b) => b.costs.total - a.costs.total)

    logger.info(
      `📊 Returning ${modelStats.length} global model stats for period ${period}:`,
      modelStats
    )

    return res.json({ success: true, data: modelStats })
  } catch (error) {
    logger.error('❌ Failed to get model stats:', error)
    return res.status(500).json({ error: 'Failed to get model stats', message: error.message })
  }
})

// 🔧 系统管理

// 清理过期数据
router.post('/cleanup', authenticateAdmin, async (req, res) => {
  try {
    const [expiredKeys, errorAccounts] = await Promise.all([
      apiKeyService.cleanupExpiredKeys(),
      claudeAccountService.cleanupErrorAccounts()
    ])

    await redis.cleanup()

    logger.success(
      `🧹 Admin triggered cleanup: ${expiredKeys} expired keys, ${errorAccounts} error accounts`
    )

    return res.json({
      success: true,
      message: 'Cleanup completed',
      data: {
        expiredKeysRemoved: expiredKeys,
        errorAccountsReset: errorAccounts
      }
    })
  } catch (error) {
    logger.error('❌ Cleanup failed:', error)
    return res.status(500).json({ error: 'Cleanup failed', message: error.message })
  }
})

// 获取使用趋势数据
router.get('/usage-trend', authenticateAdmin, async (req, res) => {
  try {
    const { days = 7, granularity = 'day', startDate, endDate } = req.query
    const client = redis.getClientSafe()

    const trendData = []

    if (granularity === 'hour') {
      // 小时粒度统计
      let startTime, endTime

      if (startDate && endDate) {
        // 使用自定义时间范围
        startTime = new Date(startDate)
        endTime = new Date(endDate)

        // 调试日志
        logger.info('📊 Usage trend hour granularity - received times:')
        logger.info(`  startDate (raw): ${startDate}`)
        logger.info(`  endDate (raw): ${endDate}`)
        logger.info(`  startTime (parsed): ${startTime.toISOString()}`)
        logger.info(`  endTime (parsed): ${endTime.toISOString()}`)
        logger.info(`  System timezone offset: ${config.system.timezoneOffset || 8}`)
      } else {
        // 默认最近24小时
        endTime = new Date()
        startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000)
      }

      // 确保时间范围不超过24小时
      const timeDiff = endTime - startTime
      if (timeDiff > 24 * 60 * 60 * 1000) {
        return res.status(400).json({
          error: '小时粒度查询时间范围不能超过24小时'
        })
      }

      // 按小时遍历
      const currentHour = new Date(startTime)
      currentHour.setMinutes(0, 0, 0)

      while (currentHour <= endTime) {
        // 注意：前端发送的时间已经是UTC时间，不需要再次转换
        // 直接从currentHour生成对应系统时区的日期和小时
        const tzCurrentHour = redis.getDateInTimezone(currentHour)
        const dateStr = redis.getDateStringInTimezone(currentHour)
        const hour = String(tzCurrentHour.getUTCHours()).padStart(2, '0')
        const hourKey = `${dateStr}:${hour}`

        // 获取当前小时的模型统计数据
        const modelPattern = `usage:model:hourly:*:${hourKey}`
        const modelKeys = await client.keys(modelPattern)

        let hourInputTokens = 0
        let hourOutputTokens = 0
        let hourRequests = 0
        let hourCacheCreateTokens = 0
        let hourCacheReadTokens = 0
        let hourCost = 0

        for (const modelKey of modelKeys) {
          const modelMatch = modelKey.match(/usage:model:hourly:(.+):\d{4}-\d{2}-\d{2}:\d{2}$/)
          if (!modelMatch) {
            continue
          }

          const model = modelMatch[1]
          const data = await client.hgetall(modelKey)

          if (data && Object.keys(data).length > 0) {
            const modelInputTokens = parseInt(data.inputTokens) || 0
            const modelOutputTokens = parseInt(data.outputTokens) || 0
            const modelCacheCreateTokens = parseInt(data.cacheCreateTokens) || 0
            const modelCacheReadTokens = parseInt(data.cacheReadTokens) || 0
            const modelRequests = parseInt(data.requests) || 0

            hourInputTokens += modelInputTokens
            hourOutputTokens += modelOutputTokens
            hourCacheCreateTokens += modelCacheCreateTokens
            hourCacheReadTokens += modelCacheReadTokens
            hourRequests += modelRequests

            const modelUsage = {
              input_tokens: modelInputTokens,
              output_tokens: modelOutputTokens,
              cache_creation_input_tokens: modelCacheCreateTokens,
              cache_read_input_tokens: modelCacheReadTokens
            }
            const modelCostResult = CostCalculator.calculateCost(modelUsage, model)
            hourCost += modelCostResult.costs.total
          }
        }

        // 如果没有模型级别的数据，尝试API Key级别的数据
        if (modelKeys.length === 0) {
          const pattern = `usage:hourly:*:${hourKey}`
          const keys = await client.keys(pattern)

          for (const key of keys) {
            const data = await client.hgetall(key)
            if (data) {
              hourInputTokens += parseInt(data.inputTokens) || 0
              hourOutputTokens += parseInt(data.outputTokens) || 0
              hourRequests += parseInt(data.requests) || 0
              hourCacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
              hourCacheReadTokens += parseInt(data.cacheReadTokens) || 0
            }
          }

          const usage = {
            input_tokens: hourInputTokens,
            output_tokens: hourOutputTokens,
            cache_creation_input_tokens: hourCacheCreateTokens,
            cache_read_input_tokens: hourCacheReadTokens
          }
          const costResult = CostCalculator.calculateCost(usage, 'unknown')
          hourCost = costResult.costs.total
        }

        // 格式化时间标签 - 使用系统时区的显示
        const tzDateForLabel = redis.getDateInTimezone(currentHour)
        const month = String(tzDateForLabel.getUTCMonth() + 1).padStart(2, '0')
        const day = String(tzDateForLabel.getUTCDate()).padStart(2, '0')
        const hourStr = String(tzDateForLabel.getUTCHours()).padStart(2, '0')

        trendData.push({
          // 对于小时粒度，只返回hour字段，不返回date字段
          hour: currentHour.toISOString(), // 保留原始ISO时间用于排序
          label: `${month}/${day} ${hourStr}:00`, // 添加格式化的标签
          inputTokens: hourInputTokens,
          outputTokens: hourOutputTokens,
          requests: hourRequests,
          cacheCreateTokens: hourCacheCreateTokens,
          cacheReadTokens: hourCacheReadTokens,
          totalTokens:
            hourInputTokens + hourOutputTokens + hourCacheCreateTokens + hourCacheReadTokens,
          cost: hourCost
        })

        // 移到下一个小时
        currentHour.setHours(currentHour.getHours() + 1)
      }
    } else {
      // 天粒度统计（保持原有逻辑）
      const daysCount = parseInt(days) || 7
      const today = new Date()

      // 获取过去N天的数据
      for (let i = 0; i < daysCount; i++) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = redis.getDateStringInTimezone(date)

        // 汇总当天所有API Key的使用数据
        const pattern = `usage:daily:*:${dateStr}`
        const keys = await client.keys(pattern)

        let dayInputTokens = 0
        let dayOutputTokens = 0
        let dayRequests = 0
        let dayCacheCreateTokens = 0
        let dayCacheReadTokens = 0
        let dayCost = 0

        // 按模型统计使用量
        // const modelUsageMap = new Map();

        // 获取当天所有模型的使用数据
        const modelPattern = `usage:model:daily:*:${dateStr}`
        const modelKeys = await client.keys(modelPattern)

        for (const modelKey of modelKeys) {
          // 解析模型名称
          const modelMatch = modelKey.match(/usage:model:daily:(.+):\d{4}-\d{2}-\d{2}$/)
          if (!modelMatch) {
            continue
          }

          const model = modelMatch[1]
          const data = await client.hgetall(modelKey)

          if (data && Object.keys(data).length > 0) {
            const modelInputTokens = parseInt(data.inputTokens) || 0
            const modelOutputTokens = parseInt(data.outputTokens) || 0
            const modelCacheCreateTokens = parseInt(data.cacheCreateTokens) || 0
            const modelCacheReadTokens = parseInt(data.cacheReadTokens) || 0
            const modelRequests = parseInt(data.requests) || 0

            // 累加总数
            dayInputTokens += modelInputTokens
            dayOutputTokens += modelOutputTokens
            dayCacheCreateTokens += modelCacheCreateTokens
            dayCacheReadTokens += modelCacheReadTokens
            dayRequests += modelRequests

            // 按模型计算费用
            const modelUsage = {
              input_tokens: modelInputTokens,
              output_tokens: modelOutputTokens,
              cache_creation_input_tokens: modelCacheCreateTokens,
              cache_read_input_tokens: modelCacheReadTokens
            }
            const modelCostResult = CostCalculator.calculateCost(modelUsage, model)
            dayCost += modelCostResult.costs.total
          }
        }

        // 如果没有模型级别的数据，回退到原始方法
        if (modelKeys.length === 0 && keys.length > 0) {
          for (const key of keys) {
            const data = await client.hgetall(key)
            if (data) {
              dayInputTokens += parseInt(data.inputTokens) || 0
              dayOutputTokens += parseInt(data.outputTokens) || 0
              dayRequests += parseInt(data.requests) || 0
              dayCacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
              dayCacheReadTokens += parseInt(data.cacheReadTokens) || 0
            }
          }

          // 使用默认模型价格计算
          const usage = {
            input_tokens: dayInputTokens,
            output_tokens: dayOutputTokens,
            cache_creation_input_tokens: dayCacheCreateTokens,
            cache_read_input_tokens: dayCacheReadTokens
          }
          const costResult = CostCalculator.calculateCost(usage, 'unknown')
          dayCost = costResult.costs.total
        }

        trendData.push({
          date: dateStr,
          inputTokens: dayInputTokens,
          outputTokens: dayOutputTokens,
          requests: dayRequests,
          cacheCreateTokens: dayCacheCreateTokens,
          cacheReadTokens: dayCacheReadTokens,
          totalTokens: dayInputTokens + dayOutputTokens + dayCacheCreateTokens + dayCacheReadTokens,
          cost: dayCost,
          formattedCost: CostCalculator.formatCost(dayCost)
        })
      }
    }

    // 按日期正序排列
    if (granularity === 'hour') {
      trendData.sort((a, b) => new Date(a.hour) - new Date(b.hour))
    } else {
      trendData.sort((a, b) => new Date(a.date) - new Date(b.date))
    }

    return res.json({ success: true, data: trendData, granularity })
  } catch (error) {
    logger.error('❌ Failed to get usage trend:', error)
    return res.status(500).json({ error: 'Failed to get usage trend', message: error.message })
  }
})

// 获取单个API Key的模型统计
router.get('/api-keys/:keyId/model-stats', authenticateAdmin, async (req, res) => {
  try {
    const { keyId } = req.params
    const { period = 'monthly', startDate, endDate } = req.query

    logger.info(
      `📊 Getting model stats for API key: ${keyId}, period: ${period}, startDate: ${startDate}, endDate: ${endDate}`
    )

    const client = redis.getClientSafe()
    const today = redis.getDateStringInTimezone()
    const tzDate = redis.getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`

    let searchPatterns = []

    if (period === 'custom' && startDate && endDate) {
      // 自定义日期范围，生成多个日期的搜索模式
      const start = new Date(startDate)
      const end = new Date(endDate)

      // 确保日期范围有效
      if (start > end) {
        return res.status(400).json({ error: 'Start date must be before or equal to end date' })
      }

      // 限制最大范围为31天
      const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1
      if (daysDiff > 31) {
        return res.status(400).json({ error: 'Date range cannot exceed 31 days' })
      }

      // 生成日期范围内所有日期的搜索模式
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = redis.getDateStringInTimezone(d)
        searchPatterns.push(`usage:${keyId}:model:daily:*:${dateStr}`)
      }

      logger.info(
        `📊 Custom date range patterns: ${searchPatterns.length} days from ${startDate} to ${endDate}`
      )
    } else {
      // 原有的预设期间逻辑
      const pattern =
        period === 'daily'
          ? `usage:${keyId}:model:daily:*:${today}`
          : `usage:${keyId}:model:monthly:*:${currentMonth}`
      searchPatterns = [pattern]
      logger.info(`📊 Preset period pattern: ${pattern}`)
    }

    // 汇总所有匹配的数据
    const modelStatsMap = new Map()
    const modelStats = [] // 定义结果数组

    for (const pattern of searchPatterns) {
      const keys = await client.keys(pattern)
      logger.info(`📊 Pattern ${pattern} found ${keys.length} keys`)

      for (const key of keys) {
        const match =
          key.match(/usage:.+:model:daily:(.+):\d{4}-\d{2}-\d{2}$/) ||
          key.match(/usage:.+:model:monthly:(.+):\d{4}-\d{2}$/)

        if (!match) {
          logger.warn(`📊 Pattern mismatch for key: ${key}`)
          continue
        }

        const model = match[1]
        const data = await client.hgetall(key)

        if (data && Object.keys(data).length > 0) {
          // 累加同一模型的数据
          if (!modelStatsMap.has(model)) {
            modelStatsMap.set(model, {
              requests: 0,
              inputTokens: 0,
              outputTokens: 0,
              cacheCreateTokens: 0,
              cacheReadTokens: 0,
              allTokens: 0
            })
          }

          const stats = modelStatsMap.get(model)
          stats.requests += parseInt(data.requests) || 0
          stats.inputTokens += parseInt(data.inputTokens) || 0
          stats.outputTokens += parseInt(data.outputTokens) || 0
          stats.cacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
          stats.cacheReadTokens += parseInt(data.cacheReadTokens) || 0
          stats.allTokens += parseInt(data.allTokens) || 0
        }
      }
    }

    // 将汇总的数据转换为最终结果
    for (const [model, stats] of modelStatsMap) {
      logger.info(`📊 Model ${model} aggregated data:`, stats)

      const usage = {
        input_tokens: stats.inputTokens,
        output_tokens: stats.outputTokens,
        cache_creation_input_tokens: stats.cacheCreateTokens,
        cache_read_input_tokens: stats.cacheReadTokens
      }

      // 使用CostCalculator计算费用
      const costData = CostCalculator.calculateCost(usage, model)

      modelStats.push({
        model,
        requests: stats.requests,
        inputTokens: stats.inputTokens,
        outputTokens: stats.outputTokens,
        cacheCreateTokens: stats.cacheCreateTokens,
        cacheReadTokens: stats.cacheReadTokens,
        allTokens: stats.allTokens,
        // 添加费用信息
        costs: costData.costs,
        formatted: costData.formatted,
        pricing: costData.pricing,
        usingDynamicPricing: costData.usingDynamicPricing
      })
    }

    // 如果没有找到模型级别的详细数据，尝试从汇总数据中生成展示
    if (modelStats.length === 0) {
      logger.info(
        `📊 No detailed model stats found, trying to get aggregate data for API key ${keyId}`
      )

      // 尝试从API Keys列表中获取usage数据作为备选方案
      try {
        const apiKeys = await apiKeyService.getAllApiKeys()
        const targetApiKey = apiKeys.find((key) => key.id === keyId)

        if (targetApiKey && targetApiKey.usage) {
          logger.info(
            `📊 Found API key usage data from getAllApiKeys for ${keyId}:`,
            targetApiKey.usage
          )

          // 从汇总数据创建展示条目
          let usageData
          if (period === 'custom' || period === 'daily') {
            // 对于自定义或日统计，使用daily数据或total数据
            usageData = targetApiKey.usage.daily || targetApiKey.usage.total
          } else {
            // 对于月统计，使用monthly数据或total数据
            usageData = targetApiKey.usage.monthly || targetApiKey.usage.total
          }

          if (usageData && usageData.allTokens > 0) {
            const usage = {
              input_tokens: usageData.inputTokens || 0,
              output_tokens: usageData.outputTokens || 0,
              cache_creation_input_tokens: usageData.cacheCreateTokens || 0,
              cache_read_input_tokens: usageData.cacheReadTokens || 0
            }

            // 对于汇总数据，使用默认模型计算费用
            const costData = CostCalculator.calculateCost(usage, 'claude-3-5-sonnet-20241022')

            modelStats.push({
              model: '总体使用 (历史数据)',
              requests: usageData.requests || 0,
              inputTokens: usageData.inputTokens || 0,
              outputTokens: usageData.outputTokens || 0,
              cacheCreateTokens: usageData.cacheCreateTokens || 0,
              cacheReadTokens: usageData.cacheReadTokens || 0,
              allTokens: usageData.allTokens || 0,
              // 添加费用信息
              costs: costData.costs,
              formatted: costData.formatted,
              pricing: costData.pricing,
              usingDynamicPricing: costData.usingDynamicPricing
            })

            logger.info('📊 Generated display data from API key usage stats')
          } else {
            logger.info(`📊 No usage data found for period ${period} in API key data`)
          }
        } else {
          logger.info(`📊 API key ${keyId} not found or has no usage data`)
        }
      } catch (error) {
        logger.error('❌ Error fetching API key usage data:', error)
      }
    }

    // 按总token数降序排列
    modelStats.sort((a, b) => b.allTokens - a.allTokens)

    logger.info(`📊 Returning ${modelStats.length} model stats for API key ${keyId}:`, modelStats)

    return res.json({ success: true, data: modelStats })
  } catch (error) {
    logger.error('❌ Failed to get API key model stats:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get API key model stats', message: error.message })
  }
})

// 获取按API Key分组的使用趋势
router.get('/api-keys-usage-trend', authenticateAdmin, async (req, res) => {
  try {
    const { granularity = 'day', days = 7, startDate, endDate } = req.query

    logger.info(`📊 Getting API keys usage trend, granularity: ${granularity}, days: ${days}`)

    const client = redis.getClientSafe()
    const trendData = []

    // 获取所有API Keys
    const apiKeys = await apiKeyService.getAllApiKeys()
    const apiKeyMap = new Map(apiKeys.map((key) => [key.id, key]))

    if (granularity === 'hour') {
      // 小时粒度统计
      let endTime, startTime

      if (startDate && endDate) {
        // 自定义时间范围
        startTime = new Date(startDate)
        endTime = new Date(endDate)
      } else {
        // 默认近24小时
        endTime = new Date()
        startTime = new Date(endTime.getTime() - 24 * 60 * 60 * 1000)
      }

      // 按小时遍历
      const currentHour = new Date(startTime)
      currentHour.setMinutes(0, 0, 0)

      while (currentHour <= endTime) {
        // 使用时区转换后的时间来生成键
        const tzCurrentHour = redis.getDateInTimezone(currentHour)
        const dateStr = redis.getDateStringInTimezone(currentHour)
        const hour = String(tzCurrentHour.getUTCHours()).padStart(2, '0')
        const hourKey = `${dateStr}:${hour}`

        // 获取这个小时所有API Key的数据
        const pattern = `usage:hourly:*:${hourKey}`
        const keys = await client.keys(pattern)

        // 格式化时间标签
        const tzDateForLabel = redis.getDateInTimezone(currentHour)
        const monthLabel = String(tzDateForLabel.getUTCMonth() + 1).padStart(2, '0')
        const dayLabel = String(tzDateForLabel.getUTCDate()).padStart(2, '0')
        const hourLabel = String(tzDateForLabel.getUTCHours()).padStart(2, '0')

        const hourData = {
          hour: currentHour.toISOString(), // 使用原始时间，不进行时区转换
          label: `${monthLabel}/${dayLabel} ${hourLabel}:00`, // 添加格式化的标签
          apiKeys: {}
        }

        // 先收集基础数据
        const apiKeyDataMap = new Map()
        for (const key of keys) {
          const match = key.match(/usage:hourly:(.+?):\d{4}-\d{2}-\d{2}:\d{2}/)
          if (!match) {
            continue
          }

          const apiKeyId = match[1]
          const data = await client.hgetall(key)

          if (data && apiKeyMap.has(apiKeyId)) {
            const inputTokens = parseInt(data.inputTokens) || 0
            const outputTokens = parseInt(data.outputTokens) || 0
            const cacheCreateTokens = parseInt(data.cacheCreateTokens) || 0
            const cacheReadTokens = parseInt(data.cacheReadTokens) || 0
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

            apiKeyDataMap.set(apiKeyId, {
              name: apiKeyMap.get(apiKeyId).name,
              tokens: totalTokens,
              requests: parseInt(data.requests) || 0,
              inputTokens,
              outputTokens,
              cacheCreateTokens,
              cacheReadTokens
            })
          }
        }

        // 获取该小时的模型级别数据来计算准确费用
        const modelPattern = `usage:*:model:hourly:*:${hourKey}`
        const modelKeys = await client.keys(modelPattern)
        const apiKeyCostMap = new Map()

        for (const modelKey of modelKeys) {
          const match = modelKey.match(/usage:(.+?):model:hourly:(.+?):\d{4}-\d{2}-\d{2}:\d{2}/)
          if (!match) {
            continue
          }

          const apiKeyId = match[1]
          const model = match[2]
          const modelData = await client.hgetall(modelKey)

          if (modelData && apiKeyDataMap.has(apiKeyId)) {
            const usage = {
              input_tokens: parseInt(modelData.inputTokens) || 0,
              output_tokens: parseInt(modelData.outputTokens) || 0,
              cache_creation_input_tokens: parseInt(modelData.cacheCreateTokens) || 0,
              cache_read_input_tokens: parseInt(modelData.cacheReadTokens) || 0
            }

            const costResult = CostCalculator.calculateCost(usage, model)
            const currentCost = apiKeyCostMap.get(apiKeyId) || 0
            apiKeyCostMap.set(apiKeyId, currentCost + costResult.costs.total)
          }
        }

        // 组合数据
        for (const [apiKeyId, data] of apiKeyDataMap) {
          const cost = apiKeyCostMap.get(apiKeyId) || 0

          // 如果没有模型级别数据，使用默认模型计算（降级方案）
          let finalCost = cost
          let formattedCost = CostCalculator.formatCost(cost)

          if (cost === 0 && data.tokens > 0) {
            const usage = {
              input_tokens: data.inputTokens,
              output_tokens: data.outputTokens,
              cache_creation_input_tokens: data.cacheCreateTokens,
              cache_read_input_tokens: data.cacheReadTokens
            }
            const fallbackResult = CostCalculator.calculateCost(usage, 'claude-3-5-sonnet-20241022')
            finalCost = fallbackResult.costs.total
            formattedCost = fallbackResult.formatted.total
          }

          hourData.apiKeys[apiKeyId] = {
            name: data.name,
            tokens: data.tokens,
            requests: data.requests,
            cost: finalCost,
            formattedCost
          }
        }

        trendData.push(hourData)
        currentHour.setHours(currentHour.getHours() + 1)
      }
    } else {
      // 天粒度统计
      const daysCount = parseInt(days) || 7
      const today = new Date()

      // 获取过去N天的数据
      for (let i = 0; i < daysCount; i++) {
        const date = new Date(today)
        date.setDate(date.getDate() - i)
        const dateStr = redis.getDateStringInTimezone(date)

        // 获取这一天所有API Key的数据
        const pattern = `usage:daily:*:${dateStr}`
        const keys = await client.keys(pattern)

        const dayData = {
          date: dateStr,
          apiKeys: {}
        }

        // 先收集基础数据
        const apiKeyDataMap = new Map()
        for (const key of keys) {
          const match = key.match(/usage:daily:(.+?):\d{4}-\d{2}-\d{2}/)
          if (!match) {
            continue
          }

          const apiKeyId = match[1]
          const data = await client.hgetall(key)

          if (data && apiKeyMap.has(apiKeyId)) {
            const inputTokens = parseInt(data.inputTokens) || 0
            const outputTokens = parseInt(data.outputTokens) || 0
            const cacheCreateTokens = parseInt(data.cacheCreateTokens) || 0
            const cacheReadTokens = parseInt(data.cacheReadTokens) || 0
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

            apiKeyDataMap.set(apiKeyId, {
              name: apiKeyMap.get(apiKeyId).name,
              tokens: totalTokens,
              requests: parseInt(data.requests) || 0,
              inputTokens,
              outputTokens,
              cacheCreateTokens,
              cacheReadTokens
            })
          }
        }

        // 获取该天的模型级别数据来计算准确费用
        const modelPattern = `usage:*:model:daily:*:${dateStr}`
        const modelKeys = await client.keys(modelPattern)
        const apiKeyCostMap = new Map()

        for (const modelKey of modelKeys) {
          const match = modelKey.match(/usage:(.+?):model:daily:(.+?):\d{4}-\d{2}-\d{2}/)
          if (!match) {
            continue
          }

          const apiKeyId = match[1]
          const model = match[2]
          const modelData = await client.hgetall(modelKey)

          if (modelData && apiKeyDataMap.has(apiKeyId)) {
            const usage = {
              input_tokens: parseInt(modelData.inputTokens) || 0,
              output_tokens: parseInt(modelData.outputTokens) || 0,
              cache_creation_input_tokens: parseInt(modelData.cacheCreateTokens) || 0,
              cache_read_input_tokens: parseInt(modelData.cacheReadTokens) || 0
            }

            const costResult = CostCalculator.calculateCost(usage, model)
            const currentCost = apiKeyCostMap.get(apiKeyId) || 0
            apiKeyCostMap.set(apiKeyId, currentCost + costResult.costs.total)
          }
        }

        // 组合数据
        for (const [apiKeyId, data] of apiKeyDataMap) {
          const cost = apiKeyCostMap.get(apiKeyId) || 0

          // 如果没有模型级别数据，使用默认模型计算（降级方案）
          let finalCost = cost
          let formattedCost = CostCalculator.formatCost(cost)

          if (cost === 0 && data.tokens > 0) {
            const usage = {
              input_tokens: data.inputTokens,
              output_tokens: data.outputTokens,
              cache_creation_input_tokens: data.cacheCreateTokens,
              cache_read_input_tokens: data.cacheReadTokens
            }
            const fallbackResult = CostCalculator.calculateCost(usage, 'claude-3-5-sonnet-20241022')
            finalCost = fallbackResult.costs.total
            formattedCost = fallbackResult.formatted.total
          }

          dayData.apiKeys[apiKeyId] = {
            name: data.name,
            tokens: data.tokens,
            requests: data.requests,
            cost: finalCost,
            formattedCost
          }
        }

        trendData.push(dayData)
      }
    }

    // 按时间正序排列
    if (granularity === 'hour') {
      trendData.sort((a, b) => new Date(a.hour) - new Date(b.hour))
    } else {
      trendData.sort((a, b) => new Date(a.date) - new Date(b.date))
    }

    // 计算每个API Key的总token数，用于排序
    const apiKeyTotals = new Map()
    for (const point of trendData) {
      for (const [apiKeyId, data] of Object.entries(point.apiKeys)) {
        apiKeyTotals.set(apiKeyId, (apiKeyTotals.get(apiKeyId) || 0) + data.tokens)
      }
    }

    // 获取前10个使用量最多的API Key
    const topApiKeys = Array.from(apiKeyTotals.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([apiKeyId]) => apiKeyId)

    return res.json({
      success: true,
      data: trendData,
      granularity,
      topApiKeys,
      totalApiKeys: apiKeyTotals.size
    })
  } catch (error) {
    logger.error('❌ Failed to get API keys usage trend:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get API keys usage trend', message: error.message })
  }
})

// 计算总体使用费用
router.get('/usage-costs', authenticateAdmin, async (req, res) => {
  try {
    const { period = 'all' } = req.query // all, today, monthly, 7days

    logger.info(`💰 Calculating usage costs for period: ${period}`)

    // 模型名标准化函数（与redis.js保持一致）
    const normalizeModelName = (model) => {
      if (!model || model === 'unknown') {
        return model
      }

      // 对于Bedrock模型，去掉区域前缀进行统一
      if (model.includes('.anthropic.') || model.includes('.claude')) {
        // 匹配所有AWS区域格式：region.anthropic.model-name-v1:0 -> claude-model-name
        // 支持所有AWS区域格式，如：us-east-1, eu-west-1, ap-southeast-1, ca-central-1等
        let normalized = model.replace(/^[a-z0-9-]+\./, '') // 去掉任何区域前缀（更通用）
        normalized = normalized.replace('anthropic.', '') // 去掉anthropic前缀
        normalized = normalized.replace(/-v\d+:\d+$/, '') // 去掉版本后缀（如-v1:0, -v2:1等）
        return normalized
      }

      // 对于其他模型，去掉常见的版本后缀
      return model.replace(/-v\d+:\d+$|:latest$/, '')
    }

    // 获取所有API Keys的使用统计
    const apiKeys = await apiKeyService.getAllApiKeys()

    const totalCosts = {
      inputCost: 0,
      outputCost: 0,
      cacheCreateCost: 0,
      cacheReadCost: 0,
      totalCost: 0
    }

    const modelCosts = {}

    // 按模型统计费用
    const client = redis.getClientSafe()
    const today = redis.getDateStringInTimezone()
    const tzDate = redis.getDateInTimezone()
    const currentMonth = `${tzDate.getUTCFullYear()}-${String(tzDate.getUTCMonth() + 1).padStart(2, '0')}`

    let pattern
    if (period === 'today') {
      pattern = `usage:model:daily:*:${today}`
    } else if (period === 'monthly') {
      pattern = `usage:model:monthly:*:${currentMonth}`
    } else if (period === '7days') {
      // 最近7天：汇总daily数据
      const modelUsageMap = new Map()

      // 获取最近7天的所有daily统计数据
      for (let i = 0; i < 7; i++) {
        const date = new Date()
        date.setDate(date.getDate() - i)
        const currentTzDate = redis.getDateInTimezone(date)
        const dateStr = `${currentTzDate.getUTCFullYear()}-${String(currentTzDate.getUTCMonth() + 1).padStart(2, '0')}-${String(currentTzDate.getUTCDate()).padStart(2, '0')}`
        const dayPattern = `usage:model:daily:*:${dateStr}`

        const dayKeys = await client.keys(dayPattern)

        for (const key of dayKeys) {
          const modelMatch = key.match(/usage:model:daily:(.+):\d{4}-\d{2}-\d{2}$/)
          if (!modelMatch) {
            continue
          }

          const rawModel = modelMatch[1]
          const normalizedModel = normalizeModelName(rawModel)
          const data = await client.hgetall(key)

          if (data && Object.keys(data).length > 0) {
            if (!modelUsageMap.has(normalizedModel)) {
              modelUsageMap.set(normalizedModel, {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0
              })
            }

            const modelUsage = modelUsageMap.get(normalizedModel)
            modelUsage.inputTokens += parseInt(data.inputTokens) || 0
            modelUsage.outputTokens += parseInt(data.outputTokens) || 0
            modelUsage.cacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
            modelUsage.cacheReadTokens += parseInt(data.cacheReadTokens) || 0
          }
        }
      }

      // 计算7天统计的费用
      logger.info(`💰 Processing ${modelUsageMap.size} unique models for 7days cost calculation`)

      for (const [model, usage] of modelUsageMap) {
        const usageData = {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreateTokens,
          cache_read_input_tokens: usage.cacheReadTokens
        }

        const costResult = CostCalculator.calculateCost(usageData, model)
        totalCosts.inputCost += costResult.costs.input
        totalCosts.outputCost += costResult.costs.output
        totalCosts.cacheCreateCost += costResult.costs.cacheWrite
        totalCosts.cacheReadCost += costResult.costs.cacheRead
        totalCosts.totalCost += costResult.costs.total

        logger.info(
          `💰 Model ${model} (7days): ${usage.inputTokens + usage.outputTokens + usage.cacheCreateTokens + usage.cacheReadTokens} tokens, cost: ${costResult.formatted.total}`
        )

        // 记录模型费用
        modelCosts[model] = {
          model,
          requests: 0, // 7天汇总数据没有请求数统计
          usage: usageData,
          costs: costResult.costs,
          formatted: costResult.formatted,
          usingDynamicPricing: costResult.usingDynamicPricing
        }
      }

      // 返回7天统计结果
      return res.json({
        success: true,
        data: {
          period,
          totalCosts: {
            ...totalCosts,
            formatted: {
              inputCost: CostCalculator.formatCost(totalCosts.inputCost),
              outputCost: CostCalculator.formatCost(totalCosts.outputCost),
              cacheCreateCost: CostCalculator.formatCost(totalCosts.cacheCreateCost),
              cacheReadCost: CostCalculator.formatCost(totalCosts.cacheReadCost),
              totalCost: CostCalculator.formatCost(totalCosts.totalCost)
            }
          },
          modelCosts: Object.values(modelCosts)
        }
      })
    } else {
      // 全部时间，先尝试从Redis获取所有历史模型统计数据（只使用monthly数据避免重复计算）
      const allModelKeys = await client.keys('usage:model:monthly:*:*')
      logger.info(`💰 Total period calculation: found ${allModelKeys.length} monthly model keys`)

      if (allModelKeys.length > 0) {
        // 如果有详细的模型统计数据，使用模型级别的计算
        const modelUsageMap = new Map()

        for (const key of allModelKeys) {
          // 解析模型名称（只处理monthly数据）
          const modelMatch = key.match(/usage:model:monthly:(.+):(\d{4}-\d{2})$/)
          if (!modelMatch) {
            continue
          }

          const model = modelMatch[1]
          const data = await client.hgetall(key)

          if (data && Object.keys(data).length > 0) {
            if (!modelUsageMap.has(model)) {
              modelUsageMap.set(model, {
                inputTokens: 0,
                outputTokens: 0,
                cacheCreateTokens: 0,
                cacheReadTokens: 0
              })
            }

            const modelUsage = modelUsageMap.get(model)
            modelUsage.inputTokens += parseInt(data.inputTokens) || 0
            modelUsage.outputTokens += parseInt(data.outputTokens) || 0
            modelUsage.cacheCreateTokens += parseInt(data.cacheCreateTokens) || 0
            modelUsage.cacheReadTokens += parseInt(data.cacheReadTokens) || 0
          }
        }

        // 使用模型级别的数据计算费用
        logger.info(`💰 Processing ${modelUsageMap.size} unique models for total cost calculation`)

        for (const [model, usage] of modelUsageMap) {
          const usageData = {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_creation_input_tokens: usage.cacheCreateTokens,
            cache_read_input_tokens: usage.cacheReadTokens
          }

          const costResult = CostCalculator.calculateCost(usageData, model)
          totalCosts.inputCost += costResult.costs.input
          totalCosts.outputCost += costResult.costs.output
          totalCosts.cacheCreateCost += costResult.costs.cacheWrite
          totalCosts.cacheReadCost += costResult.costs.cacheRead
          totalCosts.totalCost += costResult.costs.total

          logger.info(
            `💰 Model ${model}: ${usage.inputTokens + usage.outputTokens + usage.cacheCreateTokens + usage.cacheReadTokens} tokens, cost: ${costResult.formatted.total}`
          )

          // 记录模型费用
          modelCosts[model] = {
            model,
            requests: 0, // 历史汇总数据没有请求数
            usage: usageData,
            costs: costResult.costs,
            formatted: costResult.formatted,
            usingDynamicPricing: costResult.usingDynamicPricing
          }
        }
      } else {
        // 如果没有详细的模型统计数据，回退到API Key汇总数据
        logger.warn('No detailed model statistics found, falling back to API Key aggregated data')

        for (const apiKey of apiKeys) {
          if (apiKey.usage && apiKey.usage.total) {
            const usage = {
              input_tokens: apiKey.usage.total.inputTokens || 0,
              output_tokens: apiKey.usage.total.outputTokens || 0,
              cache_creation_input_tokens: apiKey.usage.total.cacheCreateTokens || 0,
              cache_read_input_tokens: apiKey.usage.total.cacheReadTokens || 0
            }

            // 使用加权平均价格计算（基于当前活跃模型的价格分布）
            const costResult = CostCalculator.calculateCost(usage, 'claude-3-5-haiku-20241022')
            totalCosts.inputCost += costResult.costs.input
            totalCosts.outputCost += costResult.costs.output
            totalCosts.cacheCreateCost += costResult.costs.cacheWrite
            totalCosts.cacheReadCost += costResult.costs.cacheRead
            totalCosts.totalCost += costResult.costs.total
          }
        }
      }

      return res.json({
        success: true,
        data: {
          period,
          totalCosts: {
            ...totalCosts,
            formatted: {
              inputCost: CostCalculator.formatCost(totalCosts.inputCost),
              outputCost: CostCalculator.formatCost(totalCosts.outputCost),
              cacheCreateCost: CostCalculator.formatCost(totalCosts.cacheCreateCost),
              cacheReadCost: CostCalculator.formatCost(totalCosts.cacheReadCost),
              totalCost: CostCalculator.formatCost(totalCosts.totalCost)
            }
          },
          modelCosts: Object.values(modelCosts).sort((a, b) => b.costs.total - a.costs.total),
          pricingServiceStatus: pricingService.getStatus()
        }
      })
    }

    // 对于今日或本月，从Redis获取详细的模型统计
    const keys = await client.keys(pattern)

    for (const key of keys) {
      const match = key.match(
        period === 'today'
          ? /usage:model:daily:(.+):\d{4}-\d{2}-\d{2}$/
          : /usage:model:monthly:(.+):\d{4}-\d{2}$/
      )

      if (!match) {
        continue
      }

      const model = match[1]
      const data = await client.hgetall(key)

      if (data && Object.keys(data).length > 0) {
        const usage = {
          input_tokens: parseInt(data.inputTokens) || 0,
          output_tokens: parseInt(data.outputTokens) || 0,
          cache_creation_input_tokens: parseInt(data.cacheCreateTokens) || 0,
          cache_read_input_tokens: parseInt(data.cacheReadTokens) || 0
        }

        const costResult = CostCalculator.calculateCost(usage, model)

        // 累加总费用
        totalCosts.inputCost += costResult.costs.input
        totalCosts.outputCost += costResult.costs.output
        totalCosts.cacheCreateCost += costResult.costs.cacheWrite
        totalCosts.cacheReadCost += costResult.costs.cacheRead
        totalCosts.totalCost += costResult.costs.total

        // 记录模型费用
        modelCosts[model] = {
          model,
          requests: parseInt(data.requests) || 0,
          usage,
          costs: costResult.costs,
          formatted: costResult.formatted,
          usingDynamicPricing: costResult.usingDynamicPricing
        }
      }
    }

    return res.json({
      success: true,
      data: {
        period,
        totalCosts: {
          ...totalCosts,
          formatted: {
            inputCost: CostCalculator.formatCost(totalCosts.inputCost),
            outputCost: CostCalculator.formatCost(totalCosts.outputCost),
            cacheCreateCost: CostCalculator.formatCost(totalCosts.cacheCreateCost),
            cacheReadCost: CostCalculator.formatCost(totalCosts.cacheReadCost),
            totalCost: CostCalculator.formatCost(totalCosts.totalCost)
          }
        },
        modelCosts: Object.values(modelCosts).sort((a, b) => b.costs.total - a.costs.total),
        pricingServiceStatus: pricingService.getStatus()
      }
    })
  } catch (error) {
    logger.error('❌ Failed to calculate usage costs:', error)
    return res
      .status(500)
      .json({ error: 'Failed to calculate usage costs', message: error.message })
  }
})

// 📋 获取所有账号的 Claude Code headers 信息
router.get('/claude-code-headers', authenticateAdmin, async (req, res) => {
  try {
    const allHeaders = await claudeCodeHeadersService.getAllAccountHeaders()

    // 获取所有 Claude 账号信息
    const accounts = await claudeAccountService.getAllAccounts()
    const accountMap = {}
    accounts.forEach((account) => {
      accountMap[account.id] = account.name
    })

    // 格式化输出
    const formattedData = Object.entries(allHeaders).map(([accountId, data]) => ({
      accountId,
      accountName: accountMap[accountId] || 'Unknown',
      version: data.version,
      userAgent: data.headers['user-agent'],
      updatedAt: data.updatedAt,
      headers: data.headers
    }))

    return res.json({
      success: true,
      data: formattedData
    })
  } catch (error) {
    logger.error('❌ Failed to get Claude Code headers:', error)
    return res
      .status(500)
      .json({ error: 'Failed to get Claude Code headers', message: error.message })
  }
})

// 🗑️ 清除指定账号的 Claude Code headers
router.delete('/claude-code-headers/:accountId', authenticateAdmin, async (req, res) => {
  try {
    const { accountId } = req.params
    await claudeCodeHeadersService.clearAccountHeaders(accountId)

    return res.json({
      success: true,
      message: `Claude Code headers cleared for account ${accountId}`
    })
  } catch (error) {
    logger.error('❌ Failed to clear Claude Code headers:', error)
    return res
      .status(500)
      .json({ error: 'Failed to clear Claude Code headers', message: error.message })
  }
})

// 🔄 版本检查
router.get('/check-updates', authenticateAdmin, async (req, res) => {
  // 读取当前版本
  const versionPath = path.join(__dirname, '../../VERSION')
  let currentVersion = '1.0.0'
  try {
    currentVersion = fs.readFileSync(versionPath, 'utf8').trim()
  } catch (err) {
    logger.warn('⚠️ Could not read VERSION file:', err.message)
  }

  try {
    // 从缓存获取
    const cacheKey = 'version_check_cache'
    const cached = await redis.getClient().get(cacheKey)

    if (cached && !req.query.force) {
      const cachedData = JSON.parse(cached)
      const cacheAge = Date.now() - cachedData.timestamp

      // 缓存有效期1小时
      if (cacheAge < 3600000) {
        // 实时计算 hasUpdate，不使用缓存的值
        const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

        return res.json({
          success: true,
          data: {
            current: currentVersion,
            latest: cachedData.latest,
            hasUpdate, // 实时计算，不用缓存
            releaseInfo: cachedData.releaseInfo,
            cached: true
          }
        })
      }
    }

    // 分发版默认不绑定任何上游仓库，只有显式配置时才检查更新
    const githubRepo = process.env.GITHUB_RELEASE_REPO
    if (!githubRepo) {
      return res.json({
        success: true,
        data: {
          current: currentVersion,
          latest: currentVersion,
          hasUpdate: false,
          releaseInfo: null,
          cached: false,
          updateSource: 'disabled'
        }
      })
    }

    // 请求 GitHub API
    const response = await axios.get(`https://api.github.com/repos/${githubRepo}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Claude-Relay-Service'
      },
      timeout: 10000
    })

    const release = response.data
    const latestVersion = release.tag_name.replace(/^v/, '')

    // 比较版本
    const hasUpdate = compareVersions(currentVersion, latestVersion) < 0

    const releaseInfo = {
      name: release.name,
      body: release.body,
      publishedAt: release.published_at,
      htmlUrl: release.html_url
    }

    // 缓存结果（不缓存 hasUpdate，因为它应该实时计算）
    await redis.getClient().set(
      cacheKey,
      JSON.stringify({
        latest: latestVersion,
        releaseInfo,
        timestamp: Date.now()
      }),
      'EX',
      3600
    ) // 1小时过期

    return res.json({
      success: true,
      data: {
        current: currentVersion,
        latest: latestVersion,
        hasUpdate,
        releaseInfo,
        cached: false,
        updateSource: githubRepo
      }
    })
  } catch (error) {
    // 改进错误日志记录
    const errorDetails = {
      message: error.message || 'Unknown error',
      code: error.code,
      response: error.response
        ? {
            status: error.response.status,
            statusText: error.response.statusText,
            data: error.response.data
          }
        : null,
      request: error.request ? 'Request was made but no response received' : null
    }

    logger.error('❌ Failed to check for updates:', errorDetails.message)

    // 处理 404 错误 - 仓库或版本不存在
    if (error.response && error.response.status === 404) {
      return res.json({
        success: true,
        data: {
          current: currentVersion,
          latest: currentVersion,
          hasUpdate: false,
          releaseInfo: {
            name: 'No releases found',
            body: 'The GitHub repository has no releases yet.',
            publishedAt: new Date().toISOString(),
            htmlUrl: '#'
          },
          warning: 'GitHub repository has no releases'
        }
      })
    }

    // 如果是网络错误，尝试返回缓存的数据
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
      const cacheKey = 'version_check_cache'
      const cached = await redis.getClient().get(cacheKey)

      if (cached) {
        const cachedData = JSON.parse(cached)
        // 实时计算 hasUpdate
        const hasUpdate = compareVersions(currentVersion, cachedData.latest) < 0

        return res.json({
          success: true,
          data: {
            current: currentVersion,
            latest: cachedData.latest,
            hasUpdate, // 实时计算
            releaseInfo: cachedData.releaseInfo,
            cached: true,
            warning: 'Using cached data due to network error'
          }
        })
      }
    }

    // 其他错误返回当前版本信息
    return res.json({
      success: true,
      data: {
        current: currentVersion,
        latest: currentVersion,
        hasUpdate: false,
        releaseInfo: {
          name: 'Update check failed',
          body: `Unable to check for updates: ${error.message || 'Unknown error'}`,
          publishedAt: new Date().toISOString(),
          htmlUrl: '#'
        },
        error: true,
        warning: error.message || 'Failed to check for updates'
      }
    })
  }
})

// 版本比较函数
function compareVersions(current, latest) {
  const parseVersion = (v) => {
    const parts = v.split('.').map(Number)
    return {
      major: parts[0] || 0,
      minor: parts[1] || 0,
      patch: parts[2] || 0
    }
  }

  const currentV = parseVersion(current)
  const latestV = parseVersion(latest)

  if (currentV.major !== latestV.major) {
    return currentV.major - latestV.major
  }
  if (currentV.minor !== latestV.minor) {
    return currentV.minor - latestV.minor
  }
  return currentV.patch - latestV.patch
}

// 🎨 OEM设置管理

// 获取OEM设置（公开接口，用于显示）
router.get('/oem-settings', async (req, res) => {
  try {
    const client = redis.getClient()
    const oemSettings = await client.get('oem:settings')

    // 默认设置
    const defaultSettings = {
      siteName: 'Safe Claude',
      siteIcon: '',
      siteIconData: '', // Base64编码的图标数据
      updatedAt: new Date().toISOString()
    }

    let settings = defaultSettings
    if (oemSettings) {
      try {
        settings = { ...defaultSettings, ...JSON.parse(oemSettings) }
      } catch (err) {
        logger.warn('⚠️ Failed to parse OEM settings, using defaults:', err.message)
      }
    }

    return res.json({
      success: true,
      data: settings
    })
  } catch (error) {
    logger.error('❌ Failed to get OEM settings:', error)
    return res.status(500).json({ error: 'Failed to get OEM settings', message: error.message })
  }
})

// 更新OEM设置
router.put('/oem-settings', authenticateAdmin, async (req, res) => {
  try {
    const { siteName, siteIcon, siteIconData } = req.body

    // 验证输入
    if (!siteName || typeof siteName !== 'string' || siteName.trim().length === 0) {
      return res.status(400).json({ error: 'Site name is required' })
    }

    if (siteName.length > 100) {
      return res.status(400).json({ error: 'Site name must be less than 100 characters' })
    }

    // 验证图标数据大小（如果是base64）
    if (siteIconData && siteIconData.length > 500000) {
      // 约375KB
      return res.status(400).json({ error: 'Icon file must be less than 350KB' })
    }

    // 验证图标URL（如果提供）
    if (siteIcon && !siteIconData) {
      // 简单验证URL格式
      try {
        new URL(siteIcon)
      } catch (err) {
        return res.status(400).json({ error: 'Invalid icon URL format' })
      }
    }

    const settings = {
      siteName: siteName.trim(),
      siteIcon: (siteIcon || '').trim(),
      siteIconData: (siteIconData || '').trim(), // Base64数据
      updatedAt: new Date().toISOString()
    }

    const client = redis.getClient()
    await client.set('oem:settings', JSON.stringify(settings))

    logger.info(`✅ OEM settings updated: ${siteName}`)

    return res.json({
      success: true,
      message: 'OEM settings updated successfully',
      data: settings
    })
  } catch (error) {
    logger.error('❌ Failed to update OEM settings:', error)
    return res.status(500).json({ error: 'Failed to update OEM settings', message: error.message })
  }
})

// Disabled provider compatibility routes
router.get('/openai-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledAccountList(res, 'OpenAI')
)
router.post('/openai-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'OpenAI')
)
router.put('/openai-accounts/:id', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'OpenAI')
)
router.delete('/openai-accounts/:id', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'OpenAI')
)
router.put('/openai-accounts/:id/toggle', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'OpenAI')
)
router.put('/openai-accounts/:accountId/toggle-schedulable', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'OpenAI')
)
router.post('/openai-accounts/generate-auth-url', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'OpenAI')
)
router.post('/openai-accounts/exchange-code', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'OpenAI')
)

router.get('/azure-openai-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledAccountList(res, 'Azure OpenAI')
)
router.post('/azure-openai-accounts', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Azure OpenAI')
)
router.put('/azure-openai-accounts/:id', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Azure OpenAI')
)
router.delete('/azure-openai-accounts/:id', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Azure OpenAI')
)
router.put('/azure-openai-accounts/:id/toggle', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Azure OpenAI')
)
router.put(
  '/azure-openai-accounts/:accountId/toggle-schedulable',
  authenticateAdmin,
  async (req, res) => sendDisabledFeatureResponse(res, 'Azure OpenAI')
)
router.post('/azure-openai-accounts/:id/health-check', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Azure OpenAI')
)
router.post('/azure-openai-accounts/health-check-all', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Azure OpenAI')
)
router.post('/migrate-api-keys-azure', authenticateAdmin, async (req, res) =>
  sendDisabledFeatureResponse(res, 'Azure OpenAI')
)

module.exports = router
