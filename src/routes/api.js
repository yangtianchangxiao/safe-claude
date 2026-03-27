const express = require('express')
const claudeRelayService = require('../services/claudeRelayService')
const claudeAccountService = require('../services/claudeAccountService')
const claudeConsoleRelayService = require('../services/claudeConsoleRelayService')
const unifiedClaudeScheduler = require('../services/unifiedClaudeScheduler')
const apiKeyService = require('../services/apiKeyService')
const { authenticateApiKey } = require('../middleware/auth')
const logger = require('../utils/logger')
const redis = require('../models/redis')
const sessionHelper = require('../utils/sessionHelper')

const router = express.Router()

// Claude Code 事件日志上报兼容接口（快速返回，避免 404 噪音）
const handleEventLoggingBatch = (req, res) => {
  req.on('error', () => {})
  req.resume()
  return res.status(204).end()
}

router.options(['/event_logging/batch', '/api/event_logging/batch'], handleEventLoggingBatch)
router.post(['/event_logging/batch', '/api/event_logging/batch'], handleEventLoggingBatch)

// 🔧 共享的消息处理函数
async function handleMessagesRequest(req, res) {
  // 💓 Keep-alive 状态（用于非流式长请求防超时）
  let keepAliveTimer = null
  let keepAliveHeadersSent = false

  try {
    const startTime = Date.now()

    // 严格的输入验证
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body must be a valid JSON object'
      })
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Missing or invalid field: messages (must be an array)'
      })
    }

    if (req.body.messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Messages array cannot be empty'
      })
    }

    // 检查是否为流式请求
    const isStream = req.body.stream === true

    logger.api(
      `🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${req.apiKey.name}`
    )

    if (isStream) {
      // 流式响应 - 只使用官方真实usage数据
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('X-Accel-Buffering', 'no') // 禁用 Nginx 缓冲

      // 禁用 Nagle 算法，确保数据立即发送
      if (res.socket && typeof res.socket.setNoDelay === 'function') {
        res.socket.setNoDelay(true)
      }

      // 流式响应不需要额外处理，中间件已经设置了监听器

      let usageDataCaptured = false

      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(req.body)

      // 使用统一调度选择账号（传递请求的模型）
      const requestedModel = req.body.model
      const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
        req.apiKey,
        sessionHash,
        requestedModel
      )

      // 根据账号类型选择对应的转发服务并调用
      if (accountType === 'claude-official') {
        // 官方Claude账号使用原有的转发服务（会自己选择账号）
        await claudeRelayService.relayStreamRequestWithUsageCapture(
          req.body,
          req.apiKey,
          res,
          req.headers,
          (usageData) => {
            // 回调函数：当检测到完整usage数据时记录真实token使用量
            logger.info(
              '🎯 Usage callback triggered with complete data:',
              JSON.stringify(usageData, null, 2)
            )

            if (
              usageData &&
              usageData.input_tokens !== undefined &&
              usageData.output_tokens !== undefined
            ) {
              const inputTokens = usageData.input_tokens || 0
              const outputTokens = usageData.output_tokens || 0
              // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
              let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
              let ephemeral5mTokens = 0
              let ephemeral1hTokens = 0

              if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                // 总的缓存创建 tokens 是两者之和
                cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
              }

              const cacheReadTokens = usageData.cache_read_input_tokens || 0
              const model = usageData.model || 'unknown'

              // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
              const { accountId: usageAccountId } = usageData

              // 构建 usage 对象以传递给 recordUsage
              const usageObject = {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreateTokens,
                cache_read_input_tokens: cacheReadTokens
              }

              // 如果有详细的缓存创建数据，添加到 usage 对象中
              if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                usageObject.cache_creation = {
                  ephemeral_5m_input_tokens: ephemeral5mTokens,
                  ephemeral_1h_input_tokens: ephemeral1hTokens
                }
              }

              apiKeyService
                .recordUsageWithDetails(req.apiKey.id, usageObject, model, usageAccountId)
                .catch((error) => {
                  logger.error('❌ Failed to record stream usage:', error)
                })

              // 更新时间窗口内的token计数
              if (req.rateLimitInfo) {
                const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
                redis
                  .getClient()
                  .incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
                  .catch((error) => {
                    logger.error('❌ Failed to update rate limit token count:', error)
                  })
                logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)
              }

              usageDataCaptured = true
              logger.api(
                `📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
              )
            } else {
              logger.warn(
                '⚠️ Usage callback triggered but data is incomplete:',
                JSON.stringify(usageData)
              )
            }
          }
        )
      } else if (accountType === 'claude-console') {
        // Claude Console账号使用Console转发服务（需要传递accountId）
        await claudeConsoleRelayService.relayStreamRequestWithUsageCapture(
          req.body,
          req.apiKey,
          res,
          req.headers,
          (usageData) => {
            // 回调函数：当检测到完整usage数据时记录真实token使用量
            logger.info(
              '🎯 Usage callback triggered with complete data:',
              JSON.stringify(usageData, null, 2)
            )

            if (
              usageData &&
              usageData.input_tokens !== undefined &&
              usageData.output_tokens !== undefined
            ) {
              const inputTokens = usageData.input_tokens || 0
              const outputTokens = usageData.output_tokens || 0
              // 兼容处理：如果有详细的 cache_creation 对象，使用它；否则使用总的 cache_creation_input_tokens
              let cacheCreateTokens = usageData.cache_creation_input_tokens || 0
              let ephemeral5mTokens = 0
              let ephemeral1hTokens = 0

              if (usageData.cache_creation && typeof usageData.cache_creation === 'object') {
                ephemeral5mTokens = usageData.cache_creation.ephemeral_5m_input_tokens || 0
                ephemeral1hTokens = usageData.cache_creation.ephemeral_1h_input_tokens || 0
                // 总的缓存创建 tokens 是两者之和
                cacheCreateTokens = ephemeral5mTokens + ephemeral1hTokens
              }

              const cacheReadTokens = usageData.cache_read_input_tokens || 0
              const model = usageData.model || 'unknown'

              // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
              const usageAccountId = usageData.accountId

              // 构建 usage 对象以传递给 recordUsage
              const usageObject = {
                input_tokens: inputTokens,
                output_tokens: outputTokens,
                cache_creation_input_tokens: cacheCreateTokens,
                cache_read_input_tokens: cacheReadTokens
              }

              // 如果有详细的缓存创建数据，添加到 usage 对象中
              if (ephemeral5mTokens > 0 || ephemeral1hTokens > 0) {
                usageObject.cache_creation = {
                  ephemeral_5m_input_tokens: ephemeral5mTokens,
                  ephemeral_1h_input_tokens: ephemeral1hTokens
                }
              }

              apiKeyService
                .recordUsageWithDetails(req.apiKey.id, usageObject, model, usageAccountId)
                .catch((error) => {
                  logger.error('❌ Failed to record stream usage:', error)
                })

              // 更新时间窗口内的token计数
              if (req.rateLimitInfo) {
                const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
                redis
                  .getClient()
                  .incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
                  .catch((error) => {
                    logger.error('❌ Failed to update rate limit token count:', error)
                  })
                logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)
              }

              usageDataCaptured = true
              logger.api(
                `📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
              )
            } else {
              logger.warn(
                '⚠️ Usage callback triggered but data is incomplete:',
                JSON.stringify(usageData)
              )
            }
          },
          accountId
        )
      } else {
        throw new Error(`Unsupported account type for stream request: ${accountType}`)
      }

      // 流式请求完成后 - 如果没有捕获到usage数据，记录警告但不进行估算
      setTimeout(() => {
        if (!usageDataCaptured) {
          logger.warn(
            '⚠️ No usage data captured from SSE stream - no statistics recorded (official data only)'
          )
        }
      }, 1000) // 1秒后检查
    } else {
      // 非流式响应 - 只使用官方真实usage数据
      logger.info('📄 Starting non-streaming request', {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name
      })

      // 生成会话哈希用于sticky会话
      const sessionHash = sessionHelper.generateSessionHash(req.body)

      // 使用统一调度选择账号（传递请求的模型）
      const requestedModel = req.body.model
      const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
        req.apiKey,
        sessionHash,
        requestedModel
      )

      // 💓 为 Claude Code 非流式请求设置 keep-alive，防止客户端 60s 空闲超时
      // 原理：上游 compact/summarize 可能需要 60-90 秒，但中转全量缓冲导致客户端
      // 在此期间收不到任何字节，触发 SDK 的空闲超时。定期发送空白字符可重置计时器。
      // JSON.parse 会忽略前导空白，所以 "   {...}" 解析结果与 "{...}" 完全相同。
      const clientUA = req.headers['user-agent'] || ''
      const isClaudeCodeNonStream = /claude-cli\/\d+\.\d+\.\d+/.test(clientUA)

      if (isClaudeCodeNonStream) {
        const KEEP_ALIVE_INTERVAL_MS = 25000 // 每 25 秒发一次（在 60s 空闲超时内至少触发一次）
        // 32 字节空白——足够触发 TCP 发包，JSON.parse 会忽略前导空白
        const KEEP_ALIVE_PADDING = '                                '
        keepAliveTimer = setInterval(() => {
          if (res.writableEnded || res.destroyed) {
            clearInterval(keepAliveTimer)
            keepAliveTimer = null
            return
          }
          if (!keepAliveHeadersSent && !res.headersSent) {
            // 禁用 Nagle 算法，确保小数据包也立即发送（与流式请求一致）
            if (res.socket && typeof res.socket.setNoDelay === 'function') {
              res.socket.setNoDelay(true)
            }
            // ⚠️ 必须禁用 compression 中间件，否则后续 write() 会被缓冲永远到不了客户端
            // 设置 Content-Encoding: identity 告知 compression 中间件跳过此响应
            res.setHeader('Content-Encoding', 'identity')
            res.writeHead(200, { 'Content-Type': 'application/json' })
            keepAliveHeadersSent = true
            logger.info('💓 Non-stream keep-alive activated (preventing client idle timeout)')
          }
          if (keepAliveHeadersSent) {
            try {
              res.write(KEEP_ALIVE_PADDING)
              // 如果 compression 中间件包装了 res，尝试显式 flush
              if (typeof res.flush === 'function') res.flush()
            } catch (e) { /* client already gone */ }
          }
        }, KEEP_ALIVE_INTERVAL_MS)
      }

      // 根据账号类型选择对应的转发服务
      let response
      logger.debug(`[DEBUG] Request query params: ${JSON.stringify(req.query)}`)
      logger.debug(`[DEBUG] Request URL: ${req.url}`)
      logger.debug(`[DEBUG] Request path: ${req.path}`)

      if (accountType === 'claude-official') {
        // 官方Claude账号使用原有的转发服务
        response = await claudeRelayService.relayRequest(
          req.body,
          req.apiKey,
          req,
          res,
          req.headers
        )
      } else if (accountType === 'claude-console') {
        // Claude Console账号使用Console转发服务
        logger.debug(
          `[DEBUG] Calling claudeConsoleRelayService.relayRequest with accountId: ${accountId}`
        )
        response = await claudeConsoleRelayService.relayRequest(
          req.body,
          req.apiKey,
          req,
          res,
          req.headers,
          accountId
        )
      } else {
        throw new Error(`Unsupported account type for non-stream request: ${accountType}`)
      }

      // 💓 上游响应已到达，清除 keep-alive 定时器
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer)
        keepAliveTimer = null
      }

      logger.info('📡 Claude API response received', {
        statusCode: response.statusCode,
        headers: JSON.stringify(response.headers),
        bodyLength: response.body ? response.body.length : 0
      })

      const upstreamStatusCode = response.statusCode || 502
      const mappedStatusCode = upstreamStatusCode === 520 ? 502 : upstreamStatusCode

      const responseBody = typeof response.body === 'string' ? response.body : ''
      const isEmptyBody = responseBody.trim().length === 0

      // 上游返回空 body 时，确保返回可读的 JSON 错误（避免客户端显示 "no body"）
      if (isEmptyBody) {
        const hintKeys = [
          'server',
          'proxy-status',
          'via',
          'cf-ray',
          'x-request-id',
          'request-id',
          'eagleid',
          'x-site-cache-status'
        ]

        const upstreamHints = {}
        for (const key of hintKeys) {
          const value = response.headers?.[key]
          if (value !== undefined) {
            upstreamHints[key] = value
          }
        }

        const statusForClient =
          mappedStatusCode >= 200 && mappedStatusCode < 300 ? 502 : mappedStatusCode

        const emptyBodyError = {
          error: 'Upstream returned empty response body',
          message:
            'Upstream responded without a body; this is usually a transient upstream/proxy/network issue.',
          upstreamService: accountType,
          upstreamStatusCode,
          ...(Object.keys(upstreamHints).length > 0 ? { upstreamHints } : {}),
          timestamp: new Date().toISOString()
        }
        if (keepAliveHeadersSent) {
          return res.end(JSON.stringify(emptyBodyError))
        }
        return res.status(statusForClient).json(emptyBodyError)
      }

      // 💓 如果 keep-alive 未激活，走正常的 status + headers 设置
      if (!keepAliveHeadersSent) {
        res.status(mappedStatusCode)

        // 设置响应头，避免 Content-Length 和 Transfer-Encoding 冲突
        const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
        Object.keys(response.headers).forEach((key) => {
          if (!skipHeaders.includes(key.toLowerCase())) {
            res.setHeader(key, response.headers[key])
          }
        })
      }

      let usageRecorded = false

      // 尝试解析JSON响应并提取usage信息
      try {
        const jsonData = JSON.parse(responseBody)
        const responseSummary = {
          requestId: req.requestId,
          upstreamService: accountType,
          statusCode: mappedStatusCode,
          type: jsonData.type,
          model: jsonData.model,
          errorType: jsonData.error?.type,
          errorMessage: jsonData.error?.message
        }
        if (mappedStatusCode >= 400) {
          logger.warn('⚠️ Claude API error response', responseSummary)

          // 🔍 403 Permission denied 错误特殊处理 - 详细日志和自动重试
          if (mappedStatusCode === 403 &&
              jsonData.error?.type === 'permission_error' &&
              accountType === 'claude-official') {

            const { accountId: responseAccountId } = response
            logger.error('🔐 403 Permission denied detected - Detailed diagnostics:', {
              requestId: req.requestId,
              accountId: responseAccountId,
              accountType: accountType,
              model: req.body.model,
              errorType: jsonData.error?.type,
              errorMessage: jsonData.error?.message,
              timestamp: new Date().toISOString()
            })

            // 尝试获取账户详细信息进行诊断
            try {
              const account = await redis.getClientSafe().hgetall(`claude:account:${responseAccountId}`)
              if (account && Object.keys(account).length > 0) {
                const expiresAt = account.expiresAt ? parseInt(account.expiresAt) : null
                const now = Date.now()
                const isExpired = expiresAt && now >= expiresAt - 60000 // 60秒提前判断

                logger.error('🔍 Account diagnostics:', {
                  accountId: responseAccountId,
                  name: account.name,
                  accountType: account.accountType,
                  expiresAt: expiresAt ? new Date(expiresAt).toISOString() : 'N/A',
                  currentTime: new Date(now).toISOString(),
                  tokenExpired: isExpired,
                  hasRefreshToken: !!account.refreshToken,
                  status: account.status,
                  isActive: account.isActive === 'true'
                })

                // 🔑 收到 403 时总是尝试刷新 token（不管技术上是否过期）
                // 因为 token 可能被服务端提前撤销
                const hasRefreshToken = account.refreshToken && account.refreshToken.length > 0

                if (hasRefreshToken) {
                  // 检查是否在短时间内已经刷新过（避免频繁刷新）
                  const lastRefresh = account.lastRefreshAt ? parseInt(account.lastRefreshAt) : 0
                  const refreshCooldown = 30000 // 30秒冷却时间
                  const now = Date.now()

                  if (now - lastRefresh > refreshCooldown) {
                    logger.warn(`🔄 403 detected, attempting token refresh for account ${responseAccountId}...`)
                    try {
                      const refreshResult = await claudeAccountService.refreshAccountToken(responseAccountId)
                      logger.info(`✅ Token refresh successful for account ${responseAccountId}, retrying request...`)

                      // 重试请求（最多一次）
                      logger.info(`🔄 Retrying request for ${req.requestId} with refreshed token`)
                      response = await claudeRelayService.relayRequest(
                        req.body,
                        req.apiKey,
                        req,
                        res,
                        req.headers
                      )
                      response.accountId = responseAccountId

                      // 更新响应状态
                      const retryStatusCode = response.statusCode || 200
                      logger.info(`🔄 Retry result: ${retryStatusCode}`)

                      // 如果重试成功，继续正常处理
                      if (retryStatusCode === 200) {
                        // 更新 statusCode 用于后续处理
                        // 需要重新解析响应
                        const retryBody = typeof response.body === 'string' ? response.body : ''
                        if (retryBody) {
                          try {
                            const retryJsonData = JSON.parse(retryBody)
                            logger.info('✅ Retry successful, using refreshed token response')
                            // 跳过错误处理，直接返回成功响应
                            if (keepAliveHeadersSent) {
                              return res.end(JSON.stringify(retryJsonData))
                            }
                            return res.status(200).json(retryJsonData)
                          } catch (parseError) {
                            logger.error('Failed to parse retry response:', parseError)
                          }
                        }
                      }
                    } catch (refreshError) {
                      logger.error(`❌ Token refresh failed for account ${responseAccountId}:`, refreshError.message)
                    }
                  } else {
                    logger.warn(`⚠️ Token refreshed recently (${Math.round((now - lastRefresh) / 1000)}s ago), skipping refresh - may be account restriction issue`)
                  }
                } else {
                  logger.warn(`⚠️ No refresh token available for account ${responseAccountId}`)
                }
              } else {
                logger.error(`❌ Account ${responseAccountId} not found in Redis`)
              }
            } catch (diagError) {
              logger.error('❌ Error getting account diagnostics:', diagError.message)
            }
          }
        } else {
          logger.info('✅ Claude API response', responseSummary)
        }

        // 从Claude API响应中提取usage信息（完整的token分类体系）
        if (
          jsonData.usage &&
          jsonData.usage.input_tokens !== undefined &&
          jsonData.usage.output_tokens !== undefined
        ) {
          const inputTokens = jsonData.usage.input_tokens || 0
          const outputTokens = jsonData.usage.output_tokens || 0
          const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0
          const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0
          const model = jsonData.model || req.body.model || 'unknown'

          // 记录真实的token使用量（包含模型信息和所有4种token以及账户ID）
          const { accountId: responseAccountId } = response
          await apiKeyService.recordUsage(
            req.apiKey.id,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model,
            responseAccountId
          )

          // 更新时间窗口内的token计数
          if (req.rateLimitInfo) {
            const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
            await redis.getClient().incrby(req.rateLimitInfo.tokenCountKey, totalTokens)
            logger.api(`📊 Updated rate limit token count: +${totalTokens} tokens`)
          }

          usageRecorded = true
          logger.api(
            `📊 Non-stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`
          )
        } else {
          logger.warn('⚠️ No usage data found in Claude API JSON response')
        }

        if (keepAliveHeadersSent) {
          res.end(JSON.stringify(jsonData))
        } else {
          res.json(jsonData)
        }
      } catch (parseError) {
        logger.warn('⚠️ Failed to parse Claude API response as JSON:', parseError.message)
        logger.info('📄 Raw response body:', response.body)
        if (keepAliveHeadersSent) {
          res.end(responseBody)
        } else {
          res.send(responseBody)
        }
      }

      // 如果没有记录usage，只记录警告，不进行估算
      if (!usageRecorded) {
        logger.warn(
          '⚠️ No usage data recorded for non-stream request - no statistics recorded (official data only)'
        )
      }
    }

    const duration = Date.now() - startTime
    logger.api(`✅ Request completed in ${duration}ms for key: ${req.apiKey.name}`)
    return undefined
  } catch (error) {
    // 💓 清除 keep-alive 定时器
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer)
      keepAliveTimer = null
    }

    const isClientDisconnected =
      error?.message === 'Client disconnected' ||
      error?.message === 'CLIENT_DISCONNECTED' ||
      req?.aborted === true ||
      res?.destroyed === true

    if (isClientDisconnected) {
      logger.info('🔌 Claude relay request ended because client disconnected')
      return undefined
    }

    logger.error('❌ Claude relay error:', error.message, {
      code: error.code,
      stack: error.stack
    })

    // 确保在任何情况下都能返回有效的JSON响应
    if (!res.headersSent) {
      // 根据错误类型设置适当的状态码
      let statusCode = 500
      let errorType = 'Relay service error'

      if (error.message.includes('Connection reset') || error.message.includes('socket hang up')) {
        statusCode = 502
        errorType = 'Upstream connection error'
      } else if (error.message.includes('Connection refused')) {
        statusCode = 502
        errorType = 'Upstream service unavailable'
      } else if (error.message.includes('timeout')) {
        statusCode = 504
        errorType = 'Upstream timeout'
      } else if (error.message.includes('resolve') || error.message.includes('ENOTFOUND')) {
        statusCode = 502
        errorType = 'Upstream hostname resolution failed'
      }

      return res.status(statusCode).json({
        error: errorType,
        message: error.message || 'An unexpected error occurred',
        timestamp: new Date().toISOString()
      })
    } else {
      // 如果响应头已经发送：优先以 SSE error 事件结束（避免客户端显示无响应/504）
      const isStreamRequest = req?.body?.stream === true
      if (isStreamRequest && !res.writableEnded && !res.destroyed) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            error: {
              type: 'relay_error',
              message: error.message || 'An unexpected error occurred'
            }
          })}\n\n`
        )
        res.write('data: [DONE]\n\n')
        res.end()
      } else if (!res.destroyed && !res.finished) {
        // 💓 keep-alive 已发送 200 headers，尝试在 body 中返回错误信息
        if (keepAliveHeadersSent) {
          try {
            res.end(JSON.stringify({
              error: { type: 'relay_error', message: error.message || 'An unexpected error occurred' }
            }))
          } catch (e) { res.end() }
        } else {
          res.end()
        }
      }
      return undefined
    }
  }
}

// 🚀 Claude API messages 端点 - /api/v1/messages
router.post('/v1/messages', authenticateApiKey, handleMessagesRequest)

// 🚀 Claude API messages 端点 - /claude/v1/messages (别名)
router.post('/claude/v1/messages', authenticateApiKey, handleMessagesRequest)

// 📋 模型列表端点 - Claude Code 客户端需要
router.get('/v1/models', authenticateApiKey, async (req, res) => {
  try {
    // 返回支持的模型列表
    const models = [
      {
        id: 'claude-3-5-sonnet-20241022',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-5-haiku-20241022',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-3-opus-20240229',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      },
      {
        id: 'claude-sonnet-4-20250514',
        object: 'model',
        created: 1669599635,
        owned_by: 'anthropic'
      }
    ]

    res.json({
      object: 'list',
      data: models
    })
  } catch (error) {
    logger.error('❌ Models list error:', error)
    res.status(500).json({
      error: 'Failed to get models list',
      message: error.message
    })
  }
})

// 🏥 健康检查端点
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await claudeRelayService.healthCheck()

    res.status(healthStatus.healthy ? 200 : 503).json({
      status: healthStatus.healthy ? 'healthy' : 'unhealthy',
      service: 'safe-claude',
      version: '1.0.0',
      ...healthStatus
    })
  } catch (error) {
    logger.error('❌ Health check error:', error)
    res.status(503).json({
      status: 'unhealthy',
      service: 'safe-claude',
      error: error.message,
      timestamp: new Date().toISOString()
    })
  }
})

// 📊 API Key状态检查端点 - /api/v1/key-info
router.get('/v1/key-info', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      keyInfo: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        tokenLimit: req.apiKey.tokenLimit,
        usage
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Key info error:', error)
    res.status(500).json({
      error: 'Failed to get key info',
      message: error.message
    })
  }
})

// 📈 使用统计端点 - /api/v1/usage
router.get('/v1/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      usage,
      limits: {
        tokens: req.apiKey.tokenLimit,
        requests: 0 // 请求限制已移除
      },
      timestamp: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ Usage stats error:', error)
    res.status(500).json({
      error: 'Failed to get usage stats',
      message: error.message
    })
  }
})

// 👤 用户信息端点 - Claude Code 客户端需要
router.get('/v1/me', authenticateApiKey, async (req, res) => {
  try {
    // 返回基础用户信息
    res.json({
      id: `user_${req.apiKey.id}`,
      type: 'user',
      display_name: req.apiKey.name || 'API User',
      created_at: new Date().toISOString()
    })
  } catch (error) {
    logger.error('❌ User info error:', error)
    res.status(500).json({
      error: 'Failed to get user info',
      message: error.message
    })
  }
})

// 💰 余额/限制端点 - Claude Code 客户端需要
router.get('/v1/organizations/:org_id/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id)

    res.json({
      object: 'usage',
      data: [
        {
          type: 'credit_balance',
          credit_balance: req.apiKey.tokenLimit - (usage.totalTokens || 0)
        }
      ]
    })
  } catch (error) {
    logger.error('❌ Organization usage error:', error)
    res.status(500).json({
      error: 'Failed to get usage info',
      message: error.message
    })
  }
})

// 🔢 Token计数端点 - count_tokens beta API
router.post('/v1/messages/count_tokens', authenticateApiKey, async (req, res) => {
  try {
    // 检查权限
    if (
      req.apiKey.permissions &&
      req.apiKey.permissions !== 'all' &&
      req.apiKey.permissions !== 'claude'
    ) {
      return res.status(403).json({
        error: {
          type: 'permission_error',
          message: 'This API key does not have permission to access Claude'
        }
      })
    }

    logger.info(`🔢 Processing token count request for key: ${req.apiKey.name}`)

    // 生成会话哈希用于sticky会话
    const sessionHash = sessionHelper.generateSessionHash(req.body)

    // 选择可用的Claude账户
    const requestedModel = req.body.model
    const { accountId, accountType } = await unifiedClaudeScheduler.selectAccountForApiKey(
      req.apiKey,
      sessionHash,
      requestedModel
    )

    let response
    if (accountType === 'claude-official') {
      // 使用官方Claude账号转发count_tokens请求
      response = await claudeRelayService.relayRequest(
        req.body,
        req.apiKey,
        req,
        res,
        req.headers,
        {
          skipUsageRecord: true, // 跳过usage记录，这只是计数请求
          customPath: '/v1/messages/count_tokens' // 指定count_tokens路径
        }
      )
    } else if (accountType === 'claude-console') {
      // 使用Console Claude账号转发count_tokens请求
      response = await claudeConsoleRelayService.relayRequest(
        req.body,
        req.apiKey,
        req,
        res,
        req.headers,
        accountId,
        {
          skipUsageRecord: true, // 跳过usage记录，这只是计数请求
          customPath: '/v1/messages/count_tokens' // 指定count_tokens路径
        }
      )
    } else {
      return res.status(500).json({
        error: {
          type: 'server_error',
          message: `Unsupported account type for token counting: ${accountType}`
        }
      })
    }

    // 直接返回响应，不记录token使用量
    res.status(response.statusCode)

    // 设置响应头
    const skipHeaders = ['content-encoding', 'transfer-encoding', 'content-length']
    Object.keys(response.headers).forEach((key) => {
      if (!skipHeaders.includes(key.toLowerCase())) {
        res.setHeader(key, response.headers[key])
      }
    })

    // 尝试解析并返回JSON响应
    try {
      const jsonData = JSON.parse(response.body)
      res.json(jsonData)
    } catch (parseError) {
      res.send(response.body)
    }

    logger.info(`✅ Token count request completed for key: ${req.apiKey.name}`)
  } catch (error) {
    logger.error('❌ Token count error:', error)
    res.status(500).json({
      error: {
        type: 'server_error',
        message: 'Failed to count tokens'
      }
    })
  }
})

module.exports = router
