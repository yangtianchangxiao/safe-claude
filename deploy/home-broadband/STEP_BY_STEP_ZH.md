# 家宽出口保姆级教程

这份文档是给第一次做这件事的人看的。

目标不是讲概念，而是让你按顺序做完，最后得到这一条链路：

`Claude Code 或 relay -> VPS 本地 tinyproxy -> WireGuard 隧道 -> 家里 Linux 机器 -> 家庭宽带公网出口`

做完以后，Anthropic 看到的是你家的公网出口，不是 VPS 的数据中心 IP。

## 先说结论

这套方案适合下面这种情况：

- 你已经把 `safe-claude` 跑起来了
- 你希望 Claude 的请求走家宽出口
- 你家里有一台长期在线的 Linux 机器
- 你能登录家里路由器做 UDP 端口转发

如果你家里是 `CGNAT`，没有公网入站，也没法做端口转发，那先不要继续。这个教程不解决那个问题。那种情况要再加一层中间 VPS 或反向隧道。

## 你需要两台机器

### 机器 A：Relay Host

也就是你的 VPS，`safe-claude` 跑在这台机器上。

### 机器 B：Home Gateway

也就是你家里的 Linux 机器。

要求：

- 长期开机
- 能联网
- 能被 WireGuard 连到

## 开始前先填这张表

先把这几个值写下来，别一边做一边猜：

- `RELAY_REPO_PATH`：你的 relay 仓库路径，例如 `/home/ubuntu/safe-claude`
- `HOME_GATEWAY_LAN_IP`：家里 Linux 机器的局域网 IP，例如 `192.168.1.20`
- `HOME_PUBLIC_ENDPOINT`：你家的公网 IP 或 DDNS 域名，例如 `myhome.example.com`
- `HOME_WAN_INTERFACE`：家里 Linux 默认出口网卡，例如 `eth0`
- `WG_PORT`：WireGuard 监听端口，默认 `51820`
- `PROXY_PORT`：VPS 本地 tinyproxy 端口，默认 `18443`

如果你有任何一项现在填不出来，先别继续。

## 第 1 步：两台机器都安装 WireGuard 工具

机器 A 和机器 B 都执行：

```bash
sudo apt-get update
sudo apt-get install -y wireguard-tools
```

检查是否安装成功：

```bash
wg --version
```

## 第 2 步：生成 WireGuard 密钥和环境文件

在任意一台有仓库的机器里执行：

```bash
cd /path/to/safe-claude/deploy/home-broadband
./generate-wireguard-keys.sh
```

执行后会生成两个文件：

- `generated/relay-host.env`
- `generated/home-gateway.env`

这两个文件里有私钥，不要提交到 git，也不要随便发给别人。

检查：

```bash
ls -l generated/
```

## 第 3 步：找出家里 Linux 的默认出口网卡

在机器 B，也就是家里的 Linux 上执行：

```bash
cd /path/to/safe-claude/deploy/home-broadband
./detect-wan-interface.sh
```

你大概率会看到类似下面的输出：

- `eth0`
- `ens3`
- `enp1s0`

把这个值记下来。

如果脚本没成功，就执行：

```bash
ip route show default
```

看输出里 `dev` 后面的值，那就是你要填的网卡名。

## 第 4 步：修改家里那台机器的 env 文件

打开：

`generated/home-gateway.env`

把这一行改掉：

```env
WAN_INTERFACE=replace-with-your-home-linux-default-interface
```

改成真实值，例如：

```env
WAN_INTERFACE=eth0
```

检查：

```bash
grep '^WAN_INTERFACE=' generated/home-gateway.env
```

## 第 5 步：确认你家的公网入口

你需要的是下面二选一：

1. 公网固定 IP
2. DDNS 域名

如果你现在不知道你家的公网 IP，在机器 B 上执行：

```bash
curl -4 ifconfig.me
```

注意：这里要的是公网地址，不是 `192.168.x.x` 这种局域网地址。

## 第 6 步：在路由器上做 UDP 端口转发

登录你家路由器后台，增加一条端口转发规则：

- 协议：`UDP`
- 外部端口：`51820`
- 内部端口：`51820`
- 内部主机：机器 B 的局域网 IP，比如 `192.168.1.20`

如果你后面不用 `51820`，那就把这里的端口改成你实际用的端口。

你要确认三件事：

- 规则已经启用
- 转发目标是正确的家里 Linux 机器
- 协议是 `UDP`，不是 `TCP`

## 第 7 步：修改 VPS 侧的 env 文件

打开：

`generated/relay-host.env`

找到这行：

```env
WG_ENDPOINT=replace-with-your-home-public-ip-or-ddns:51820
```

改成你家的公网入口，例如：

```env
WG_ENDPOINT=203.0.113.24:51820
```

或者：

```env
WG_ENDPOINT=myhome.example.com:51820
```

检查：

```bash
grep '^WG_ENDPOINT=' generated/relay-host.env
```

## 第 8 步：把两个 env 文件放到对应机器上

原则很简单：

- `home-gateway.env` 放到机器 B
- `relay-host.env` 放到机器 A

如果两台机器之间能 SSH，你可以用 `scp`。如果不能，就直接手动复制粘贴内容。

只要保证最后两台机器各自拿到正确的 env 文件就行。

## 第 9 步：先安装家里那一侧

在机器 B 执行：

```bash
cd /path/to/safe-claude/deploy/home-broadband
set -a
source ./generated/home-gateway.env
set +a
sudo -E ./install-home-gateway.sh
```

执行后检查：

```bash
sudo systemctl status wg-quick@wg-home.service --no-pager
sudo wg show wg-home
```

你应该看到：

- `wg-quick@wg-home.service` 已经起来
- `wg-home` 接口存在

此时还没有握手也正常，因为 VPS 那边还没连上来。

## 第 10 步：再安装 VPS 这一侧

在机器 A 执行：

```bash
cd /path/to/safe-claude/deploy/home-broadband
set -a
source ./generated/relay-host.env
set +a
sudo -E ./install-relay-host-egress.sh
```

执行后检查：

```bash
sudo systemctl status tinyproxy-claude.service --no-pager
sudo systemctl status wg-quick@wg-claude.service --no-pager
sudo wg show wg-claude
```

你应该看到：

- `tinyproxy-claude.service` 是运行中
- `wg-quick@wg-claude.service` 是 active
- `wg-claude` 里能看到 peer

## 第 11 步：先确认 WireGuard 真的握手成功

机器 A 和机器 B 都执行：

```bash
sudo wg show
```

看这几个点：

- `latest handshake` 不是空的
- 时间是最近的
- 后面发起测试流量后，`transfer` 计数会增加

如果这里没有握手，不要继续测代理。先把 WireGuard 打通。

## 第 12 步：测试 VPS 本地代理的出口 IP

在机器 A 执行：

```bash
cd /path/to/safe-claude/deploy/home-broadband
PROXY_PORT=18443 ./test-egress.sh
```

你应该看到一个 IP。

判断标准：

- 如果这个 IP 是你家的公网 IP，说明已经成功走家宽出口
- 如果这个 IP 还是 VPS 的 IP，说明 tinyproxy 是通的，但策略路由没生效
- 如果超时，说明 WireGuard 还没真正通

## 第 13 步：让 Claude Code 走这个本地代理

在机器 A 执行：

```bash
cd /path/to/safe-claude/deploy/home-broadband
./claude-code-with-proxy.sh claude
```

这个脚本会自动给当前命令加上：

```bash
HTTPS_PROXY=http://127.0.0.1:18443
HTTP_PROXY=http://127.0.0.1:18443
```

你可以先这样检查环境变量有没有带上：

```bash
./claude-code-with-proxy.sh env | grep -i proxy
```

## 第 14 步：让 relay 服务也走同一个出口

如果你希望 relay 服务本身也走同一个家宽出口，有三种方法。

### 方法 A：在当前 shell 里启动 relay

```bash
cd /path/to/safe-claude
export HTTPS_PROXY=http://127.0.0.1:18443
export HTTP_PROXY=$HTTPS_PROXY
npm start
```

### 方法 B：给 systemd 服务加环境变量

如果你的 relay 是 systemd 管的，执行：

```bash
sudo systemctl edit safe-claude.service
```

然后写入：

```ini
[Service]
Environment=HTTPS_PROXY=http://127.0.0.1:18443
Environment=HTTP_PROXY=http://127.0.0.1:18443
```

保存后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart safe-claude.service
```

如果你的服务名不是 `safe-claude.service`，就替换成你自己的。

### 方法 C：只给 Claude 账户单独配代理

如果你不想让整个 relay 进程都走代理，可以在 admin UI 里只给 Claude 账户配置代理。

这样更干净：

- Redis 不走代理
- 健康检查不走代理
- 其他无关流量不走代理

## 第 15 步：测试 Anthropic 的真实连通性

在机器 A 执行：

```bash
curl --proxy http://127.0.0.1:18443 -I https://api.anthropic.com
```

再测一下控制台：

```bash
curl --proxy http://127.0.0.1:18443 -I https://console.anthropic.com
```

如果都能正常连上，再发一个真实 Claude 请求，确认 relay 仍然工作。

## 常见故障排查

### 故障 1：`wg show` 没有 handshake

常见原因：

- `WG_ENDPOINT` 写错了
- 路由器没有做 UDP 转发
- 端口转发指向了错误的内网机器
- 家里的 Linux 没在线
- 家宽运营商把这个 UDP 端口挡了

处理顺序：

1. 先检查 `WG_ENDPOINT`
2. 再检查路由器端口转发
3. 再检查机器 B 是否在线
4. 如果还不行，换一个 UDP 端口，记得两边 env 和路由器一起改

### 故障 2：代理能用，但出口 IP 还是 VPS IP

这说明 tinyproxy 起了，但策略路由没有把代理用户的流量送进 WireGuard。

在机器 A 执行：

```bash
id claudeproxy
ip rule
ip route show table 184
sudo systemctl status wg-quick@wg-claude.service --no-pager
```

你应该看到：

- `claudeproxy` 用户存在
- `ip rule` 里有把这个用户导向路由表 `184` 的规则
- `table 184` 里有默认路由指向 `wg-claude`

### 故障 3：家里那台机器装好了，但不能出网

通常是 `WAN_INTERFACE` 写错了，或者 NAT 没加对。

在机器 B 执行：

```bash
ip route show default
sudo iptables -t nat -S
```

检查 `POSTROUTING` 规则里使用的网卡，必须是你真实的默认出口网卡。

### 故障 4：Claude Code 还是没走代理

常见原因：

- 你直接执行了 `claude`
- 当前 shell 里残留了旧的代理变量
- Claude Code 不是从 wrapper 脚本启动的

正确做法：

```bash
./claude-code-with-proxy.sh claude
```

或者手动导出：

```bash
export HTTPS_PROXY=http://127.0.0.1:18443
export HTTP_PROXY=$HTTPS_PROXY
```

然后检查：

```bash
env | grep -i proxy
```

### 故障 5：你家是 CGNAT

这个教程不解决。

你需要的是：

1. 再加一台中间 VPS
2. 或者做反向隧道

那是另一套架构，不是这份文档里的两机直连。

## 最后验收清单

全部满足，才算真的完成：

- 两边 `wg show` 都能看到最近握手
- `./test-egress.sh` 打印的是你家的公网 IP
- `curl --proxy http://127.0.0.1:18443 -I https://api.anthropic.com` 能连通
- `./claude-code-with-proxy.sh claude` 启动后的 Claude Code 可以正常使用
- relay 服务在带代理环境变量或账户级代理的情况下也能正常工作

如果你要把这套作为公开教程给别人用，优先把这份中文文档给他们，不要直接把 shell 脚本甩给新手。
