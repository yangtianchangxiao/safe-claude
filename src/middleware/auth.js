const apiKeyService = require('../services/apiKeyService')
const logger = require('../utils/logger')
const redis = require('../models/redis')
const { RateLimiterRedis } = require('rate-limiter-flexible')
const config = require('../../config/config')

const QUIET_REQUEST_PATHS = new Set([
  '/health',
  '/api/event_logging/batch',
  '/api/api/event_logging/batch',
  '/claude/event_logging/batch',
  '/claude/api/event_logging/batch'
])

// 🔑 API Key验证中间件（优化版）
const authenticateApiKey = async (req, res, next) => {
  const startTime = Date.now()

  try {
    // 安全提取 API Key，支持常见头部格式
    const apiKey =
      req.headers['x-api-key'] ||
      req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
      req.headers['api-key'] ||
      req.query.key

    if (!apiKey) {
      logger.security(`🔒 Missing API key attempt from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Missing API key',
        message: 'Please provide an API key in the x-api-key header or Authorization header'
      })
    }

    // 基本API Key格式验证
    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
      logger.security(`🔒 Invalid API key format from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Invalid API key format',
        message: 'API key format is invalid'
      })
    }

    // 验证API Key（带缓存优化）
    const validation = await apiKeyService.validateApiKey(apiKey)

    if (!validation.valid) {
      const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'
      logger.security(`🔒 Invalid API key attempt: ${validation.error} from ${clientIP}`)
      return res.status(401).json({
        error: 'Invalid API key',
        message: validation.error
      })
    }

    // 🔒 检查客户端限制
    if (
      validation.keyData.enableClientRestriction &&
      validation.keyData.allowedClients?.length > 0
    ) {
      const userAgent = req.headers['user-agent'] || ''
      const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'

      // 记录客户端限制检查开始
      logger.api(
        `🔍 Checking client restriction for key: ${validation.keyData.id} (${validation.keyData.name})`
      )
      logger.api(`   User-Agent: "${userAgent}"`)
      logger.api(`   Allowed clients: ${validation.keyData.allowedClients.join(', ')}`)

      let clientAllowed = false
      let matchedClient = null

      // 获取预定义客户端列表，如果配置不存在则使用默认值
      const predefinedClients = config.clientRestrictions?.predefinedClients || []
      const allowCustomClients = config.clientRestrictions?.allowCustomClients || false

      // 遍历允许的客户端列表
      for (const allowedClientId of validation.keyData.allowedClients) {
        // 在预定义客户端列表中查找
        const predefinedClient = predefinedClients.find((client) => client.id === allowedClientId)

        if (predefinedClient) {
          // 使用预定义的正则表达式匹配 User-Agent
          if (
            predefinedClient.userAgentPattern &&
            predefinedClient.userAgentPattern.test(userAgent)
          ) {
            clientAllowed = true
            matchedClient = predefinedClient.name
            break
          }
        } else if (allowCustomClients) {
          // 如果允许自定义客户端，这里可以添加自定义客户端的验证逻辑
          // 目前暂时跳过自定义客户端
          continue
        }
      }

      if (!clientAllowed) {
        logger.security(
          `🚫 Client restriction failed for key: ${validation.keyData.id} (${validation.keyData.name}) from ${clientIP}, User-Agent: ${userAgent}`
        )
        return res.status(403).json({
          error: 'Client not allowed',
          message: 'Your client is not authorized to use this API key',
          allowedClients: validation.keyData.allowedClients
        })
      }

      logger.api(
        `✅ Client validated: ${matchedClient} for key: ${validation.keyData.id} (${validation.keyData.name})`
      )
      logger.api(`   Matched client: ${matchedClient} with User-Agent: "${userAgent}"`)
    }

    // 检查并发限制
    const concurrencyLimit = validation.keyData.concurrencyLimit || 0
    if (concurrencyLimit > 0) {
      const currentConcurrency = await redis.incrConcurrency(validation.keyData.id)
      logger.api(
        `📈 Incremented concurrency for key: ${validation.keyData.id} (${validation.keyData.name}), current: ${currentConcurrency}, limit: ${concurrencyLimit}`
      )

      if (currentConcurrency > concurrencyLimit) {
        // 如果超过限制，立即减少计数
        await redis.decrConcurrency(validation.keyData.id)
        logger.security(
          `🚦 Concurrency limit exceeded for key: ${validation.keyData.id} (${validation.keyData.name}), current: ${currentConcurrency - 1}, limit: ${concurrencyLimit}`
        )
        return res.status(429).json({
          error: 'Concurrency limit exceeded',
          message: `Too many concurrent requests. Limit: ${concurrencyLimit} concurrent requests`,
          currentConcurrency: currentConcurrency - 1,
          concurrencyLimit
        })
      }

      // 使用标志位确保只减少一次
      let concurrencyDecremented = false

      const decrementConcurrency = async () => {
        if (!concurrencyDecremented) {
          concurrencyDecremented = true
          try {
            const newCount = await redis.decrConcurrency(validation.keyData.id)
            logger.api(
              `📉 Decremented concurrency for key: ${validation.keyData.id} (${validation.keyData.name}), new count: ${newCount}`
            )
          } catch (error) {
            logger.error(`Failed to decrement concurrency for key ${validation.keyData.id}:`, error)
          }
        }
      }

      // 监听最可靠的事件（避免重复监听）
      // res.on('close') 是最可靠的，会在连接关闭时触发
      res.once('close', () => {
        logger.api(
          `🔌 Response closed for key: ${validation.keyData.id} (${validation.keyData.name})`
        )
        decrementConcurrency()
      })

      // req.on('close') 作为备用，处理请求端断开
      req.once('close', () => {
        logger.api(
          `🔌 Request closed for key: ${validation.keyData.id} (${validation.keyData.name})`
        )
        decrementConcurrency()
      })

      // res.on('finish') 处理正常完成的情况
      res.once('finish', () => {
        logger.api(
          `✅ Response finished for key: ${validation.keyData.id} (${validation.keyData.name})`
        )
        decrementConcurrency()
      })

      // 存储并发信息到请求对象，便于后续处理
      req.concurrencyInfo = {
        apiKeyId: validation.keyData.id,
        apiKeyName: validation.keyData.name,
        decrementConcurrency
      }
    }

    // 检查时间窗口限流
    const rateLimitWindow = validation.keyData.rateLimitWindow || 0
    const rateLimitRequests = validation.keyData.rateLimitRequests || 0

    if (rateLimitWindow > 0 && (rateLimitRequests > 0 || validation.keyData.tokenLimit > 0)) {
      const windowStartKey = `rate_limit:window_start:${validation.keyData.id}`
      const requestCountKey = `rate_limit:requests:${validation.keyData.id}`
      const tokenCountKey = `rate_limit:tokens:${validation.keyData.id}`

      const now = Date.now()
      const windowDuration = rateLimitWindow * 60 * 1000 // 转换为毫秒

      // 获取窗口开始时间
      let windowStart = await redis.getClient().get(windowStartKey)

      if (!windowStart) {
        // 第一次请求，设置窗口开始时间
        await redis.getClient().set(windowStartKey, now, 'PX', windowDuration)
        await redis.getClient().set(requestCountKey, 0, 'PX', windowDuration)
        await redis.getClient().set(tokenCountKey, 0, 'PX', windowDuration)
        windowStart = now
      } else {
        windowStart = parseInt(windowStart)

        // 检查窗口是否已过期
        if (now - windowStart >= windowDuration) {
          // 窗口已过期，重置
          await redis.getClient().set(windowStartKey, now, 'PX', windowDuration)
          await redis.getClient().set(requestCountKey, 0, 'PX', windowDuration)
          await redis.getClient().set(tokenCountKey, 0, 'PX', windowDuration)
          windowStart = now
        }
      }

      // 获取当前计数
      const currentRequests = parseInt((await redis.getClient().get(requestCountKey)) || '0')
      const currentTokens = parseInt((await redis.getClient().get(tokenCountKey)) || '0')

      // 检查请求次数限制
      if (rateLimitRequests > 0 && currentRequests >= rateLimitRequests) {
        const resetTime = new Date(windowStart + windowDuration)
        const remainingMinutes = Math.ceil((resetTime - now) / 60000)

        logger.security(
          `🚦 Rate limit exceeded (requests) for key: ${validation.keyData.id} (${validation.keyData.name}), requests: ${currentRequests}/${rateLimitRequests}`
        )

        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: `已达到请求次数限制 (${rateLimitRequests} 次)，将在 ${remainingMinutes} 分钟后重置`,
          currentRequests,
          requestLimit: rateLimitRequests,
          resetAt: resetTime.toISOString(),
          remainingMinutes
        })
      }

      // 检查Token使用量限制
      const tokenLimit = parseInt(validation.keyData.tokenLimit)
      if (tokenLimit > 0 && currentTokens >= tokenLimit) {
        const resetTime = new Date(windowStart + windowDuration)
        const remainingMinutes = Math.ceil((resetTime - now) / 60000)

        logger.security(
          `🚦 Rate limit exceeded (tokens) for key: ${validation.keyData.id} (${validation.keyData.name}), tokens: ${currentTokens}/${tokenLimit}`
        )

        return res.status(429).json({
          error: 'Rate limit exceeded',
          message: `已达到 Token 使用限制 (${tokenLimit} tokens)，将在 ${remainingMinutes} 分钟后重置`,
          currentTokens,
          tokenLimit,
          resetAt: resetTime.toISOString(),
          remainingMinutes
        })
      }

      // 增加请求计数
      await redis.getClient().incr(requestCountKey)

      // 存储限流信息到请求对象
      req.rateLimitInfo = {
        windowStart,
        windowDuration,
        requestCountKey,
        tokenCountKey,
        currentRequests: currentRequests + 1,
        currentTokens,
        rateLimitRequests,
        tokenLimit
      }
    }

    // 检查每日费用限制
    const dailyCostLimit = validation.keyData.dailyCostLimit || 0
    if (dailyCostLimit > 0) {
      const dailyCost = validation.keyData.dailyCost || 0

      if (dailyCost >= dailyCostLimit) {
        logger.security(
          `💰 Daily cost limit exceeded for key: ${validation.keyData.id} (${validation.keyData.name}), cost: $${dailyCost.toFixed(2)}/$${dailyCostLimit}`
        )

        return res.status(429).json({
          error: 'Daily cost limit exceeded',
          message: `已达到每日费用限制 ($${dailyCostLimit})`,
          currentCost: dailyCost,
          costLimit: dailyCostLimit,
          resetAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString() // 明天0点重置
        })
      }

      // 记录当前费用使用情况
      logger.api(
        `💰 Cost usage for key: ${validation.keyData.id} (${validation.keyData.name}), current: $${dailyCost.toFixed(2)}/$${dailyCostLimit}`
      )
    }

    // 将验证信息添加到请求对象（只包含必要信息）
    req.apiKey = {
      id: validation.keyData.id,
      name: validation.keyData.name,
      tokenLimit: validation.keyData.tokenLimit,
      claudeAccountId: validation.keyData.claudeAccountId,
      claudeConsoleAccountId: validation.keyData.claudeConsoleAccountId,
      permissions: validation.keyData.permissions,
      concurrencyLimit: validation.keyData.concurrencyLimit,
      rateLimitWindow: validation.keyData.rateLimitWindow,
      rateLimitRequests: validation.keyData.rateLimitRequests,
      enableModelRestriction: validation.keyData.enableModelRestriction,
      restrictedModels: validation.keyData.restrictedModels,
      enableClientRestriction: validation.keyData.enableClientRestriction,
      allowedClients: validation.keyData.allowedClients,
      dailyCostLimit: validation.keyData.dailyCostLimit,
      dailyCost: validation.keyData.dailyCost,
      usage: validation.keyData.usage
    }
    req.usage = validation.keyData.usage

    const authDuration = Date.now() - startTime
    const userAgent = req.headers['user-agent'] || 'No User-Agent'
    logger.api(
      `🔓 Authenticated request from key: ${validation.keyData.name} (${validation.keyData.id}) in ${authDuration}ms`
    )
    logger.api(`   User-Agent: "${userAgent}"`)

    return next()
  } catch (error) {
    const authDuration = Date.now() - startTime
    logger.error(`❌ Authentication middleware error (${authDuration}ms):`, {
      error: error.message,
      stack: error.stack,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl
    })

    return res.status(500).json({
      error: 'Authentication error',
      message: 'Internal server error during authentication'
    })
  }
}

// 🛡️ 管理员验证中间件（优化版）
const authenticateAdmin = async (req, res, next) => {
  const startTime = Date.now()

  try {
    // 安全提取token，支持多种方式
    const token =
      req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
      req.cookies?.adminToken ||
      req.headers['x-admin-token']

    if (!token) {
      logger.security(`🔒 Missing admin token attempt from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Missing admin token',
        message: 'Please provide an admin token'
      })
    }

    // 基本token格式验证
    if (typeof token !== 'string' || token.length < 32 || token.length > 512) {
      logger.security(`🔒 Invalid admin token format from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Invalid admin token format',
        message: 'Admin token format is invalid'
      })
    }

    // 获取管理员会话（带超时处理）
    const adminSession = await Promise.race([
      redis.getSession(token),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Session lookup timeout')), 5000)
      )
    ])

    if (!adminSession || Object.keys(adminSession).length === 0) {
      logger.security(`🔒 Invalid admin token attempt from ${req.ip || 'unknown'}`)
      return res.status(401).json({
        error: 'Invalid admin token',
        message: 'Invalid or expired admin session'
      })
    }

    // 检查会话活跃性（可选：检查最后活动时间）
    const now = new Date()
    const lastActivity = new Date(adminSession.lastActivity || adminSession.loginTime)
    const inactiveDuration = now - lastActivity
    const maxInactivity = 24 * 60 * 60 * 1000 // 24小时

    if (inactiveDuration > maxInactivity) {
      logger.security(
        `🔒 Expired admin session for ${adminSession.username} from ${req.ip || 'unknown'}`
      )
      await redis.deleteSession(token) // 清理过期会话
      return res.status(401).json({
        error: 'Session expired',
        message: 'Admin session has expired due to inactivity'
      })
    }

    // 更新最后活动时间（异步，不阻塞请求）
    redis
      .setSession(
        token,
        {
          ...adminSession,
          lastActivity: now.toISOString()
        },
        86400
      )
      .catch((error) => {
        logger.error('Failed to update admin session activity:', error)
      })

    // 设置管理员信息（只包含必要信息）
    req.admin = {
      id: adminSession.adminId || 'admin',
      username: adminSession.username,
      sessionId: token,
      loginTime: adminSession.loginTime
    }

    const authDuration = Date.now() - startTime
    logger.security(`🔐 Admin authenticated: ${adminSession.username} in ${authDuration}ms`)

    return next()
  } catch (error) {
    const authDuration = Date.now() - startTime
    logger.error(`❌ Admin authentication error (${authDuration}ms):`, {
      error: error.message,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      url: req.originalUrl
    })

    return res.status(500).json({
      error: 'Authentication error',
      message: 'Internal server error during admin authentication'
    })
  }
}

// 注意：使用统计现在直接在/api/v1/messages路由中处理，
// 以便从Claude API响应中提取真实的usage数据

// 🚦 CORS中间件（优化版）
const corsMiddleware = (req, res, next) => {
  const { origin } = req.headers

  // 允许的源（可以从配置文件读取）
  const allowedOrigins = [
    'http://localhost:3000',
    'https://localhost:3000',
    'http://127.0.0.1:3000',
    'https://127.0.0.1:3000'
  ]

  // 设置CORS头
  if (allowedOrigins.includes(origin) || !origin) {
    res.header('Access-Control-Allow-Origin', origin || '*')
  }

  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS')
  res.header(
    'Access-Control-Allow-Headers',
    [
      'Origin',
      'X-Requested-With',
      'Content-Type',
      'Accept',
      'Authorization',
      'x-api-key',
      'api-key',
      'x-admin-token'
    ].join(', ')
  )

  res.header('Access-Control-Expose-Headers', ['X-Request-ID', 'Content-Type'].join(', '))

  res.header('Access-Control-Max-Age', '86400') // 24小时预检缓存
  res.header('Access-Control-Allow-Credentials', 'true')

  if (req.method === 'OPTIONS') {
    res.status(204).end()
  } else {
    next()
  }
}

// 📝 请求日志中间件（优化版）
const requestLogger = (req, res, next) => {
  const start = Date.now()
  const requestId = Math.random().toString(36).substring(2, 15)
  const requestPath = req.path || req.originalUrl || ''
  const isQuietRequest = QUIET_REQUEST_PATHS.has(requestPath)

  // 添加请求ID到请求对象
  req.requestId = requestId
  res.setHeader('X-Request-ID', requestId)

  // 获取客户端信息
  const clientIP = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown'
  const userAgent = req.get('User-Agent') || 'unknown'
  const referer = req.get('Referer') || 'none'

  // 记录请求开始
  if (!isQuietRequest) {
    logger.info(`▶️ [${requestId}] ${req.method} ${req.originalUrl} | IP: ${clientIP}`)
  }

  res.on('finish', () => {
    const duration = Date.now() - start
    const contentLength = res.get('Content-Length') || '0'

    // 构建日志元数据
    const logMetadata = {
      requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      contentLength,
      ip: clientIP,
      userAgent,
      referer
    }

    if (isQuietRequest && res.statusCode < 400) {
      return
    }

    // 根据状态码选择日志级别
    if (res.statusCode >= 500) {
      logger.error(
        `◀️ [${requestId}] ${req.method} ${req.originalUrl} | ${res.statusCode} | ${duration}ms | ${contentLength}B`,
        logMetadata
      )
    } else if (res.statusCode >= 400) {
      logger.warn(
        `◀️ [${requestId}] ${req.method} ${req.originalUrl} | ${res.statusCode} | ${duration}ms | ${contentLength}B`,
        logMetadata
      )
    } else {
      logger.request(req.method, req.originalUrl, res.statusCode, duration, logMetadata)
    }

    // API Key相关日志
    if (req.apiKey) {
      logger.api(
        `📱 [${requestId}] Request from ${req.apiKey.name} (${req.apiKey.id}) | ${duration}ms`
      )
    }

    // 慢请求警告
    if (duration > 5000) {
      logger.warn(
        `🐌 [${requestId}] Slow request detected: ${duration}ms for ${req.method} ${req.originalUrl}`
      )
    }
  })

  res.on('error', (error) => {
    const duration = Date.now() - start
    logger.error(`💥 [${requestId}] Response error after ${duration}ms:`, error)
  })

  next()
}

// 🛡️ 安全中间件（增强版）
const securityMiddleware = (req, res, next) => {
  // 设置基础安全头
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('X-XSS-Protection', '1; mode=block')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  // 添加更多安全头
  res.setHeader('X-DNS-Prefetch-Control', 'off')
  res.setHeader('X-Download-Options', 'noopen')
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none')

  // Cross-Origin-Opener-Policy (仅对可信来源设置)
  const host = req.get('host') || ''
  const isLocalhost =
    host.includes('localhost') || host.includes('127.0.0.1') || host.includes('0.0.0.0')
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https'

  if (isLocalhost || isHttps) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Origin-Agent-Cluster', '?1')
  }

  // Content Security Policy (适用于web界面)
  if (req.path.startsWith('/web') || req.path === '/') {
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://cdn.bootcdn.net",
        "style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdnjs.cloudflare.com https://cdn.bootcdn.net",
        "font-src 'self' https://cdnjs.cloudflare.com https://cdn.bootcdn.net",
        "img-src 'self' data:",
        "connect-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'"
      ].join('; ')
    )
  }

  // Strict Transport Security (HTTPS)
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
  }

  // 移除泄露服务器信息的头
  res.removeHeader('X-Powered-By')
  res.removeHeader('Server')

  // 防止信息泄露
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')

  next()
}

// 🚨 错误处理中间件（增强版）
const errorHandler = (error, req, res, _next) => {
  const requestId = req.requestId || 'unknown'
  const isDevelopment = process.env.NODE_ENV === 'development'

  // 记录详细错误信息
  logger.error(`💥 [${requestId}] Unhandled error:`, {
    error: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    ip: req.ip || 'unknown',
    userAgent: req.get('User-Agent') || 'unknown',
    apiKey: req.apiKey ? req.apiKey.id : 'none',
    admin: req.admin ? req.admin.username : 'none'
  })

  // 确定HTTP状态码
  let statusCode = 500
  let errorMessage = 'Internal Server Error'
  let userMessage = 'Something went wrong'

  if (error.status && error.status >= 400 && error.status < 600) {
    statusCode = error.status
  }

  // 根据错误类型提供友好的错误消息
  switch (error.name) {
    case 'ValidationError':
      statusCode = 400
      errorMessage = 'Validation Error'
      userMessage = 'Invalid input data'
      break
    case 'CastError':
      statusCode = 400
      errorMessage = 'Cast Error'
      userMessage = 'Invalid data format'
      break
    case 'MongoError':
    case 'RedisError':
      statusCode = 503
      errorMessage = 'Database Error'
      userMessage = 'Database temporarily unavailable'
      break
    case 'TimeoutError':
      statusCode = 408
      errorMessage = 'Request Timeout'
      userMessage = 'Request took too long to process'
      break
    default:
      if (error.message && !isDevelopment) {
        // 在生产环境中，只显示安全的错误消息
        if (error.message.includes('ECONNREFUSED')) {
          userMessage = 'Service temporarily unavailable'
        } else if (error.message.includes('timeout')) {
          userMessage = 'Request timeout'
        }
      }
  }

  // 设置响应头
  res.setHeader('X-Request-ID', requestId)

  // 构建错误响应
  const errorResponse = {
    error: errorMessage,
    message: isDevelopment ? error.message : userMessage,
    requestId,
    timestamp: new Date().toISOString()
  }

  // 在开发环境中包含更多调试信息
  if (isDevelopment) {
    errorResponse.stack = error.stack
    errorResponse.url = req.originalUrl
    errorResponse.method = req.method
  }

  res.status(statusCode).json(errorResponse)
}

// 🌐 全局速率限制中间件（延迟初始化）
let rateLimiter = null

const getRateLimiter = () => {
  if (!rateLimiter) {
    try {
      const client = redis.getClient()
      if (!client) {
        logger.warn('⚠️ Redis client not available for rate limiter')
        return null
      }

      rateLimiter = new RateLimiterRedis({
        storeClient: client,
        keyPrefix: 'global_rate_limit',
        points: 1000, // 请求数量
        duration: 900, // 15分钟 (900秒)
        blockDuration: 900 // 阻塞时间15分钟
      })

      logger.info('✅ Rate limiter initialized successfully')
    } catch (error) {
      logger.warn('⚠️ Rate limiter initialization failed, using fallback', { error: error.message })
      return null
    }
  }
  return rateLimiter
}

const globalRateLimit = async (req, res, next) => {
  // 跳过健康检查和内部请求
  if (req.path === '/health' || req.path === '/api/health') {
    return next()
  }

  const limiter = getRateLimiter()
  if (!limiter) {
    // 如果Redis不可用，直接跳过速率限制
    return next()
  }

  const clientIP = req.ip || req.connection?.remoteAddress || 'unknown'

  try {
    await limiter.consume(clientIP)
    return next()
  } catch (rejRes) {
    const remainingPoints = rejRes.remainingPoints || 0
    const msBeforeNext = rejRes.msBeforeNext || 900000

    logger.security(`🚦 Global rate limit exceeded for IP: ${clientIP}`)

    res.set({
      'Retry-After': Math.round(msBeforeNext / 1000) || 900,
      'X-RateLimit-Limit': 1000,
      'X-RateLimit-Remaining': remainingPoints,
      'X-RateLimit-Reset': new Date(Date.now() + msBeforeNext).toISOString()
    })

    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Too many requests from this IP, please try again later.',
      retryAfter: Math.round(msBeforeNext / 1000)
    })
  }
}

// 📊 请求大小限制中间件
const requestSizeLimit = (req, res, next) => {
  const maxSize = 10 * 1024 * 1024 // 10MB
  const contentLength = parseInt(req.headers['content-length'] || '0')

  if (contentLength > maxSize) {
    logger.security(`🚨 Request too large: ${contentLength} bytes from ${req.ip}`)
    return res.status(413).json({
      error: 'Payload Too Large',
      message: 'Request body size exceeds limit',
      limit: '10MB'
    })
  }

  return next()
}

module.exports = {
  authenticateApiKey,
  authenticateAdmin,
  corsMiddleware,
  requestLogger,
  securityMiddleware,
  errorHandler,
  globalRateLimit,
  requestSizeLimit
}
