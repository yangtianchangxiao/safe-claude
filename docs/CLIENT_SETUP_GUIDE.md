# 客户端配置指南

这份指南讲的是：怎么把 Claude Code 和别的客户端接到 `safe-claude` 上。

目标很简单：

- 你已经把 relay 跑起来
- 你已经在后台添加好了 Claude 账户
- 你已经创建了一个 `cr_...` API key
- 现在你要让 Windows、macOS、Linux 上的 Claude Code 接进来

## 先记住这两个环境变量

如果你沿用我们旧项目的接入方式，优先使用这两个：

- `ANTHROPIC_BASE_URL`
- `ANTHROPIC_AUTH_TOKEN`

其中：

- `ANTHROPIC_BASE_URL` 必须包含 `/api`
- `ANTHROPIC_AUTH_TOKEN` 必须是 relay 生成的 `cr_...` key

推荐写法：

- 域名部署：`https://relay.example.com/api`
- 无域名回退：`http://SERVER_IP:3000/api`
- 本机测试：`http://127.0.0.1:3000/api`

## 先准备好这两个值

你需要把下面两个值替换成你自己的：

- `YOUR_RELAY_URL`
- `YOUR_CR_API_KEY`

示例：

```text
YOUR_RELAY_URL=https://relay.example.com/api
YOUR_CR_API_KEY=cr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

如果你还没有这两个值，先回到主 README：

-  [README.md](../README.md)

## Windows PowerShell

### 方法一：永久设置，推荐

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "https://relay.example.com/api", [System.EnvironmentVariableTarget]::User)
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "cr_your_api_key", [System.EnvironmentVariableTarget]::User)
```

如果你还没有域名，可以先用：

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://SERVER_IP:3000/api", [System.EnvironmentVariableTarget]::User)
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "cr_your_api_key", [System.EnvironmentVariableTarget]::User)
```

验证：

```powershell
[System.Environment]::GetEnvironmentVariable("ANTHROPIC_BASE_URL", [System.EnvironmentVariableTarget]::User)
[System.Environment]::GetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", [System.EnvironmentVariableTarget]::User)
```

设置完以后，重新打开 PowerShell 再测试。

### 方法二：当前会话临时设置

```powershell
$env:ANTHROPIC_BASE_URL = "https://relay.example.com/api"
$env:ANTHROPIC_AUTH_TOKEN = "cr_your_api_key"
```

本机测试版：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000/api"
$env:ANTHROPIC_AUTH_TOKEN = "cr_your_api_key"
```

### 如果 PowerShell 执行策略拦你

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

## macOS

### zsh 永久设置

```bash
echo 'export ANTHROPIC_BASE_URL="https://relay.example.com/api"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"' >> ~/.zshrc
source ~/.zshrc
```

### bash 永久设置

```bash
echo 'export ANTHROPIC_BASE_URL="https://relay.example.com/api"' >> ~/.bash_profile
echo 'export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"' >> ~/.bash_profile
source ~/.bash_profile
```

### 当前终端临时设置

```bash
export ANTHROPIC_BASE_URL="https://relay.example.com/api"
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
```

## Linux

### bash 永久设置

```bash
echo 'export ANTHROPIC_BASE_URL="https://relay.example.com/api"' >> ~/.bashrc
echo 'export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"' >> ~/.bashrc
source ~/.bashrc
```

### zsh 永久设置

```bash
echo 'export ANTHROPIC_BASE_URL="https://relay.example.com/api"' >> ~/.zshrc
echo 'export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"' >> ~/.zshrc
source ~/.zshrc
```

### 当前终端临时设置

```bash
export ANTHROPIC_BASE_URL="https://relay.example.com/api"
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
```

## 没有域名时怎么写

如果你还没有域名，可以先用服务器 IP：

### Windows PowerShell

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://SERVER_IP:3000/api", [System.EnvironmentVariableTarget]::User)
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_AUTH_TOKEN", "cr_your_api_key", [System.EnvironmentVariableTarget]::User)
```

### macOS 或 Linux

```bash
export ANTHROPIC_BASE_URL="http://SERVER_IP:3000/api"
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
```

## 本机测试怎么写

如果 Claude Code 和 relay 在同一台机器上：

### Windows PowerShell

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:3000/api"
$env:ANTHROPIC_AUTH_TOKEN = "cr_your_api_key"
```

### macOS 或 Linux

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000/api"
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
```

## 验证环境变量

### Windows PowerShell

```powershell
echo $env:ANTHROPIC_BASE_URL
echo $env:ANTHROPIC_AUTH_TOKEN
```

### macOS 或 Linux

```bash
echo $ANTHROPIC_BASE_URL
echo $ANTHROPIC_AUTH_TOKEN
```

你应该看到：

- 一个包含 `/api` 的 URL
- 一个 `cr_...` 开头的 token

## 验证 relay 本身

先确认 relay 是活的：

```bash
curl https://relay.example.com/health
```

如果你还没有域名：

```bash
curl http://SERVER_IP:3000/health
```

本机测试：

```bash
curl http://127.0.0.1:3000/health
```

## 验证 API 调用

```bash
curl -X POST https://relay.example.com/api/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer cr_your_api_key" \
  -d '{
    "model": "claude-3-7-sonnet-latest",
    "max_tokens": 64,
    "messages": [
      {"role": "user", "content": "hello"}
    ]
  }'
```

如果你现在还没有域名，把 `https://relay.example.com` 换成你的 `http://SERVER_IP:3000`。

## 常见错误

### 1. 404 Route not found

通常原因：`ANTHROPIC_BASE_URL` 没带 `/api`

正确：

```text
https://relay.example.com/api
```

错误：

```text
https://relay.example.com
```

### 2. 401 Unauthorized

通常原因：

- `ANTHROPIC_AUTH_TOKEN` 不对
- 你填的不是 `cr_...` relay key
- 这个 key 已禁用或过期

### 3. Connection refused

通常原因：

- relay 没启动
- 端口没放通
- 你用了错误的 IP/域名/端口

### 4. Windows 设置完没生效

通常原因：

- 你没有重新打开 PowerShell
- 你改的是当前会话，不是用户级环境变量

## 最重要的 4 条

1. 优先用域名，`localhost` 只是回退
2. `ANTHROPIC_BASE_URL` 必须带 `/api`
3. token 用 relay 生成的 `cr_...`
4. 先确认 `/health` 通，再测 Claude Code
