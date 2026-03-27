# safe-claude

> 天下苦 Claude 久矣。
>
> `safe-claude` 做的事很简单：把你自己的 Claude 网关搭起来，少踩坑，少绕路，少和一堆机器私货死磕。

English: [README.en.md](./README.en.md)

## 这是什么

一句话：

`safe-claude` 是一个可以自己部署的 Claude 网关。

你把自己的 Claude 账号接进来，它就给你一个稳定的 API 入口。然后你可以让 Claude Code 或别的兼容客户端走这个入口。

## 你能拿它做什么

- 跑一个自己的 Claude 服务入口
- 后台添加 Claude 账号
- 生成 `cr_...` API key
- 让 Claude Code 指到你的域名、IP 或 localhost
- 需要的话，再接代理、家宽出口、Nginx 域名

## 最短上手

### 方案 1：一键安装

适合 Ubuntu / Debian。

```bash
git clone git@github.com:yangtianchangxiao/safe-claude.git
cd safe-claude
sudo ./install-safe-claude.sh
```

这个脚本会做这些事：

- 安装或检查 Node.js 18+
- 安装 Redis
- 复制 `.env`
- 生成密钥
- 安装依赖
- 初始化管理员账号
- 创建 `safe-claude.service`
- 启动服务

脚本跑完后，你就可以先打开：

- 后台：`http://你的IP:3000/admin-next/`
- 健康检查：`http://你的IP:3000/health`

如果你已经有域名，优先用：

- `https://relay.example.com/admin-next/`
- `https://relay.example.com/api`

### 方案 2：手动安装

```bash
cp .env.example .env
npm install
npm run setup
npm start
```

## 跑起来以后怎么用

顺序别乱。就按这个来。

如果你准备让 Claude 的登录和后续请求都走家宽，那有一个时机一定别搞错：

- 网站和后台能正常打开以后
- 先把家宽出口接好
- 再去登录 Claude、添加 Claude 账号

不要先用 VPS 默认出口去登录 Claude，后面再切到家宽。这样做账号风险会高很多。

### 第 1 步：打开后台

地址：

- `http://你的IP:3000/admin-next/`
- 或 `https://你的域名/admin-next/`

登录账号和密码是在 `npm run setup` 或一键安装时生成的。

### 第 2 步：添加 Claude 账号

进后台以后：

1. 打开 Claude 账号页面
2. 添加 Claude OAuth 或 Claude Console 账号
3. 按页面提示完成授权
4. 确认账号状态可用

### 第 3 步：创建 API key

进后台以后：

1. 打开 API Keys 页面
2. 新建一个 key
3. 保持 Claude 权限开启
4. 记下生成的 `cr_...` key

### 第 4 步：让 Claude Code 走你的网关

有域名时，推荐这样配：

```bash
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
export ANTHROPIC_BASE_URL="https://relay.example.com/api"
```

还没有域名时，先这样：

```bash
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
export ANTHROPIC_BASE_URL="http://你的IP:3000/api"
```

如果你就在服务器本机测试，也可以先用：

```bash
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000/api"
```

### 第 5 步：确认它真的能用

```bash
curl http://127.0.0.1:3000/health
```

再发一个最小请求：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer cr_your_api_key" \
  -d '{
    "model": "claude-3-7-sonnet-latest",
    "max_tokens": 128,
    "messages": [
      {"role": "user", "content": "hello from safe-claude"}
    ]
  }'
```

## 域名和 localhost 怎么选

一句话：

- 正式用：域名 + HTTPS
- 本机试：localhost / 127.0.0.1

原因很简单：

- 用户更容易记
- Claude Code 配置更稳定
- 浏览器登录更顺
- 后面接 Nginx 也更规范

如果你要绑域名，直接看：

- [deploy/nginx/STEP_BY_STEP_ZH.md](./deploy/nginx/STEP_BY_STEP_ZH.md)

## 家宽出口什么时候再上

这件事要分两段看。

第一段：

- 先把网站跑起来
- 先确认 `/admin-next/` 能打开
- 先确认你能正常进后台

第二段：

- 如果你计划让 Claude 账号长期走家宽
- 那就在第一次登录 Claude 之前
- 先把家宽出口接好

也就是说，正确顺序不是：

1. 先用 VPS 出口登录 Claude
2. 后面再切家宽

正确顺序是：

1. 先把 `safe-claude` 网站跑起来
2. 确认后台能打开
3. 先把 Claude 相关流量切到家宽
4. 再登录 Claude、添加 Claude 账号

这样账号风险更低。

如果你要把 Anthropic 流量走家宽，直接看：

- [docs/egress-home-broadband.md](./docs/egress-home-broadband.md)
- [deploy/home-broadband/STEP_BY_STEP_ZH.md](./deploy/home-broadband/STEP_BY_STEP_ZH.md)

如果你只是想接客户端，不想折腾家宽，先看：

- [docs/CLIENT_SETUP_GUIDE.md](./docs/CLIENT_SETUP_GUIDE.md)

## 文档怎么选

- 我只想先把服务跑起来：看这份 README
- 我要绑域名：看 [deploy/nginx/STEP_BY_STEP_ZH.md](./deploy/nginx/STEP_BY_STEP_ZH.md)
- 我要接家宽出口：看 [deploy/home-broadband/STEP_BY_STEP_ZH.md](./deploy/home-broadband/STEP_BY_STEP_ZH.md)
- 我要看全平台客户端接入：看 [docs/CLIENT_SETUP_GUIDE.md](./docs/CLIENT_SETUP_GUIDE.md)
- 我要看英文：看 [README.en.md](./README.en.md)

## 上游说明

这个仓库基于下面的上游项目整理而来：

- `https://github.com/Wei-Shaw/claude-relay-service`

公开发布时，应该保留：

- 上游链接
- MIT License
- `NOTICE` 文件
