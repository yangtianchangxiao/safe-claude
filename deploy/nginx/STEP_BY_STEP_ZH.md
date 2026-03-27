# Nginx 绑定域名保姆级教程

这份教程对应的是你现在生产机上的那种思路，但只保留 `safe-claude` 需要的最小部分。

最终结构是：

`用户 -> 域名 -> Nginx -> safe-claude(127.0.0.1:3000)`

也就是说：

- 用户访问 `https://relay.example.com`
- Nginx 对外监听 `80/443`
- relay 自己只监听本地 `127.0.0.1:3000`

## 这份教程解决什么问题

它解决的是：

1. 给 relay 绑定域名
2. 用 HTTPS 对外提供服务
3. 让客户端访问 `https://your-domain/api`
4. 不让用户直接记 `IP:3000`

## 开始前先确认

你至少要有这些：

- 一台已经跑起 `safe-claude` 的 Linux 服务器
- 一个已经解析到这台服务器公网 IP 的域名
- root 或 sudo 权限
- 服务器 80 和 443 端口可用

如果你连 relay 本身都还没跑起来，先回主 README：

- [README.md](../../README.md)

## 第 1 步：先让 relay 只监听本地

推荐把 relay 监听到 `127.0.0.1:3000`，而不是直接暴露到公网。

`.env` 示例：

```env
HOST=127.0.0.1
PORT=3000
```

然后先确认本机可访问：

```bash
curl http://127.0.0.1:3000/health
```

如果这里都不通，不要继续搞 Nginx。

## 第 2 步：安装 Nginx 和 Certbot

Ubuntu 上执行：

```bash
sudo apt-get update
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

检查：

```bash
nginx -v
certbot --version
```

## 第 3 步：准备变量文件

复制模板：

```bash
cd /home/ubuntu/safe-claude/deploy/nginx
cp nginx-site.env.example nginx-site.env
```

你至少要改这几个值：

- `DOMAIN`
- `UPSTREAM_HOST`
- `UPSTREAM_PORT`
- `SITE_NAME`

典型示例：

```env
DOMAIN=relay.example.com
SITE_NAME=safe-claude
UPSTREAM_HOST=127.0.0.1
UPSTREAM_PORT=3000
ENABLE_TLS=false
```

为什么先 `ENABLE_TLS=false`：

因为第一次通常要先用 HTTP 配好站点，让 Certbot 能自动签证书。

## 第 4 步：安装 HTTP 版站点配置

执行：

```bash
cd /home/ubuntu/safe-claude/deploy/nginx
set -a
source ./nginx-site.env
set +a
sudo -E ./install-nginx-site.sh
```

这个脚本会做这些事：

1. 根据变量生成 Nginx 配置
2. 写到 `/etc/nginx/sites-available/<SITE_NAME>.conf`
3. 自动创建 `sites-enabled` 软链接
4. 执行 `nginx -t`
5. 自动 reload Nginx

## 第 5 步：先验证 HTTP 可达

先从服务器本机测：

```bash
curl -I http://127.0.0.1:3000/health
curl -I http://YOUR_DOMAIN/health
```

再从外部机器测：

```bash
curl -I http://YOUR_DOMAIN/health
```

如果 `http://YOUR_DOMAIN/health` 都不通，就不要继续签 HTTPS。

先检查：

- DNS 是否已经指向服务器 IP
- 防火墙是否放行 80
- Nginx 配置是否正确

## 第 6 步：申请 Let's Encrypt 证书

如果 DNS 已经生效，执行：

```bash
cd /home/ubuntu/safe-claude/deploy/nginx
CERTBOT_EMAIL=you@example.com DOMAIN=relay.example.com sudo -E ./issue-certbot-certificate.sh
```

这个脚本会调用：

```bash
certbot --nginx -d relay.example.com --non-interactive --agree-tos -m you@example.com --redirect
```

如果你不想用脚本，也可以自己直接运行 `certbot`。

## 第 7 步：把站点切到模板化 HTTPS 配置

证书签好后，修改 `nginx-site.env`：

```env
ENABLE_TLS=true
TLS_CERT_PATH=/etc/letsencrypt/live/relay.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/relay.example.com/privkey.pem
```

然后重新安装站点：

```bash
cd /home/ubuntu/safe-claude/deploy/nginx
set -a
source ./nginx-site.env
set +a
sudo -E ./install-nginx-site.sh
```

这样以后你的站点配置就回到仓库模板控制里，而不是完全依赖 Certbot 自动改出来的版本。

## 第 8 步：验证 HTTPS

验证健康检查：

```bash
curl -I https://YOUR_DOMAIN/health
```

验证管理后台：

```bash
curl -I https://YOUR_DOMAIN/admin-next/
```

验证 API：

```bash
curl -I https://YOUR_DOMAIN/api/v1/messages
```

你真正给用户的地址应该是：

- 管理后台：`https://YOUR_DOMAIN/admin-next/`
- API 基址：`https://YOUR_DOMAIN/api`

## 第 9 步：告诉客户端怎么写

客户端应该优先写域名版：

```bash
export ANTHROPIC_BASE_URL="https://YOUR_DOMAIN/api"
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
```

而不是默认教用户写：

```bash
http://SERVER_IP:3000/api
```

后者只应该当作没有域名时的回退方案。

## 常见问题

### 问题 1：Nginx 起来了，但 `YOUR_DOMAIN/health` 不通

通常是：

- DNS 没生效
- 80/443 没放通
- Nginx 没 reload 成功

检查：

```bash
sudo nginx -t
sudo systemctl status nginx --no-pager
ss -ltnp | grep ':80\|:443'
```

### 问题 2：Nginx 通了，但页面 502

这说明 Nginx 到 relay 的反代不通。

检查：

```bash
curl http://127.0.0.1:3000/health
```

如果这里不通，先修 relay。

### 问题 3：`curl http://127.0.0.1:3000/health` 通，但域名 502

通常是 Nginx 里 `proxy_pass` 写错了。

检查变量：

- `UPSTREAM_HOST`
- `UPSTREAM_PORT`

### 问题 4：Certbot 申请失败

通常是：

- 域名还没解析到这台机器
- 80 端口没开放
- 域名被 CDN 或别的反代挡住了

## 最后验收清单

全部满足才算完成：

- `curl http://127.0.0.1:3000/health` 正常
- `curl -I http://YOUR_DOMAIN/health` 正常
- `curl -I https://YOUR_DOMAIN/health` 正常
- `https://YOUR_DOMAIN/admin-next/` 能打开
- 客户端最终使用 `https://YOUR_DOMAIN/api`
