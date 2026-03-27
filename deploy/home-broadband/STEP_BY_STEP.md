# Step-By-Step Guide

This is the hand-holding version.

If you want the same Claude Code proxy pattern used on the current server, follow this file from top to bottom without skipping ahead.

## What You Are Building

You will end up with this path:

`Claude Code or relay -> local tinyproxy on the relay host -> WireGuard tunnel -> home Linux box -> home broadband public exit`

Anthropic will see the home broadband exit, not the relay host's data center IP.

## Machines You Need

### Machine A: Relay Host

This is your VPS where `safe-claude` runs.

### Machine B: Home Gateway

This is a Linux machine inside your home network.

It must:

- stay online
- have outbound internet
- be reachable by WireGuard from the relay host

## Before You Start

You need all of these:

1. `safe-claude` already copied to the relay host
2. root or sudo on both machines
3. Ubuntu or another Linux distro on the home gateway
4. router access so you can forward one UDP port to the home gateway

If your home network is behind CGNAT and you cannot port-forward, stop here. This first version is not the right deployment shape. You will need an extra edge VPS or reverse tunnel.

## Fill In This Worksheet First

Write down these values before you begin:

- relay host path: for example `/home/ubuntu/safe-claude`
- home gateway LAN IP: for example `192.168.1.20`
- home public IP or DDNS hostname: for example `myhome.example.com`
- home WAN interface: for example `eth0` or `enp1s0`
- WireGuard UDP port: default `51820`
- local proxy port on the relay host: default `18443`

If you cannot fill in one of those values, do not continue yet.

## Step 1: Install WireGuard Tools On Both Machines

Run this on both the relay host and the home gateway:

```bash
sudo apt-get update
sudo apt-get install -y wireguard-tools
```

Success check:

```bash
wg --version
```

## Step 2: Generate Keys

Run this on either machine inside the repo:

```bash
cd /path/to/safe-claude/deploy/home-broadband
./generate-wireguard-keys.sh
```

This creates:

- `generated/relay-host.env`
- `generated/home-gateway.env`

Do not commit these files. They contain private keys.

Success check:

```bash
ls -l generated/
```

You should see both env files.

## Step 3: Find The Home Gateway WAN Interface

Run this on the home gateway:

```bash
cd /path/to/safe-claude/deploy/home-broadband
./detect-wan-interface.sh
```

Typical outputs:

- `eth0`
- `ens3`
- `enp1s0`

Copy that value.

If the helper fails, run:

```bash
ip route show default
```

The interface name is the value after `dev`.

## Step 4: Edit The Home Gateway Env File

Open `generated/home-gateway.env`.

Set:

```env
WAN_INTERFACE=the-interface-you-found
```

Example:

```env
WAN_INTERFACE=eth0
```

Leave the generated keys as they are.

Success check:

```bash
grep '^WAN_INTERFACE=' generated/home-gateway.env
```

## Step 5: Find The Public Endpoint Of Your Home Network

You need one of these:

1. a static public IP
2. a DDNS hostname

If you do not already know it, from the home gateway run:

```bash
curl -4 ifconfig.me
```

If you use dynamic DNS, use that hostname instead of the raw IP.

Important: this must be the public address that the relay host can reach from the internet, not your home gateway's LAN address like `192.168.x.x`.

## Step 6: Forward The WireGuard Port On Your Home Router

In your router admin page, create a port-forward rule:

- Protocol: `UDP`
- External Port: `51820`
- Internal Port: `51820`
- Internal Host: IP of your home gateway Linux machine

If you changed `WG_LISTEN_PORT`, forward that port instead.

Success check from the router side:

- the rule is enabled
- the internal target points to the correct home gateway machine
- the external and internal UDP ports match your env file

## Step 7: Edit The Relay Host Env File

Open `generated/relay-host.env`.

Set:

```env
WG_ENDPOINT=your-home-public-ip-or-ddns:51820
```

Example:

```env
WG_ENDPOINT=203.0.113.24:51820
```

or

```env
WG_ENDPOINT=myhome.example.com:51820
```

Success check:

```bash
grep '^WG_ENDPOINT=' generated/relay-host.env
```

## Step 8: Copy The Generated Env Files To The Correct Machines

Copy:

- `generated/home-gateway.env` to the home gateway
- `generated/relay-host.env` to the relay host

You can use `scp`, `rsync`, or paste the content manually.

If you generate the files on the relay host and the home gateway has SSH access from the relay host, this works:

```bash
scp generated/home-gateway.env user@home-gateway:/tmp/home-gateway.env
```

If the home machine is not directly reachable by SSH from the relay host, just open the file and paste it manually onto the home machine.

## Step 9: Install The Home Gateway Side

Run this on the home gateway:

```bash
cd /path/to/safe-claude/deploy/home-broadband
set -a
source ./generated/home-gateway.env
set +a
sudo -E ./install-home-gateway.sh
```

Then verify:

```bash
sudo systemctl status wg-quick@wg-home.service --no-pager
sudo wg show wg-home
```

Expected result:

- `wg-quick@wg-home.service` is `active (exited)` or `active`
- `wg show wg-home` prints the interface

At this stage, it is normal if you do not see a handshake yet. The relay side is not up yet.

## Step 10: Install The Relay Host Side

Run this on the relay host:

```bash
cd /path/to/safe-claude/deploy/home-broadband
set -a
source ./generated/relay-host.env
set +a
sudo -E ./install-relay-host-egress.sh
```

Then verify:

```bash
sudo systemctl status tinyproxy-claude.service --no-pager
sudo systemctl status wg-quick@wg-claude.service --no-pager
sudo wg show wg-claude
```

Expected result:

- `tinyproxy-claude.service` is `active (running)`
- `wg-quick@wg-claude.service` is `active (exited)` or `active`
- `wg show wg-claude` shows a peer

## Step 11: Confirm WireGuard Handshake

Run this on both machines:

```bash
sudo wg show
```

Expected result:

- the peer exists on both sides
- `latest handshake` is recent
- transfer counters increase after test traffic

If there is no handshake, do not continue to the proxy test. Fix WireGuard first.

## Step 12: Test The Proxy Exit On The Relay Host

Run:

```bash
cd /path/to/safe-claude/deploy/home-broadband
PROXY_PORT=18443 ./test-egress.sh
```

Expected result:

- it prints an IP
- that IP should be your home broadband public IP, not the VPS IP

If it prints the VPS IP, the proxy is up but policy routing is wrong.

If it times out, WireGuard is not really connected.

## Step 13: Run Claude Code Through The Local Proxy

On the relay host:

```bash
cd /path/to/safe-claude/deploy/home-broadband
./claude-code-with-proxy.sh claude
```

That wraps Claude Code with:

```bash
HTTPS_PROXY=http://127.0.0.1:18443
HTTP_PROXY=http://127.0.0.1:18443
```

Quick check:

```bash
./claude-code-with-proxy.sh env | grep -i proxy
```

You should see the proxy variables.

## Step 14: Make The Relay Service Use The Same Exit

If you also want the relay service itself to leave through the same local proxy, you have two clean options.

### Option A: start the relay in a proxied shell

```bash
cd /path/to/safe-claude
export HTTPS_PROXY=http://127.0.0.1:18443
export HTTP_PROXY=$HTTPS_PROXY
npm start
```

### Option B: put the proxy in the relay service unit

If your relay runs as a systemd service, create an override:

```bash
sudo systemctl edit safe-claude.service
```

Then add:

```ini
[Service]
Environment=HTTPS_PROXY=http://127.0.0.1:18443
Environment=HTTP_PROXY=http://127.0.0.1:18443
```

Then reload and restart:

```bash
sudo systemctl daemon-reload
sudo systemctl restart safe-claude.service
```

Replace `safe-claude.service` with your actual service name if it is different.

### Option C: configure the proxy per Claude account in the admin UI

If you prefer not to proxy the whole relay process, store the proxy on the specific Claude account instead.

That keeps Redis, health checks, and unrelated traffic on the normal route.

## Step 15: Confirm Anthropic Traffic Really Leaves Through Home Broadband

On the relay host, test through the proxy:

```bash
curl --proxy http://127.0.0.1:18443 -I https://api.anthropic.com
```

The request should connect successfully.

You can also test the OAuth path:

```bash
curl --proxy http://127.0.0.1:18443 -I https://console.anthropic.com
```

Then send one real Claude request and confirm that the relay still works.

## Common Problems

### Problem 1: `wg show` on the relay host shows no handshake

Cause:

- wrong `WG_ENDPOINT`
- router port-forward missing
- home gateway not reachable
- home ISP blocks the chosen UDP port

Fix:

1. re-check `WG_ENDPOINT`
2. re-check UDP port-forward
3. confirm the home gateway is online
4. try another UDP port and update both env files plus the router forward rule

### Problem 2: proxy works, but the exit IP is still the VPS IP

Cause:

- WireGuard may be up
- but the policy routing for the proxy user is not working

Fix:

Run:

```bash
id claudeproxy
ip rule
ip route show table 184
sudo systemctl status wg-quick@wg-claude.service --no-pager
```

You should see a rule that routes the proxy user into table `184` by default.

### Problem 3: home gateway installs, but traffic does not leave to the internet

Cause:

- wrong `WAN_INTERFACE`
- NAT rule did not apply

Fix:

Run on the home gateway:

```bash
ip route show default
sudo iptables -t nat -S
```

Then make sure the interface in `POSTROUTING` matches the real WAN interface.

### Problem 4: Claude Code still does not use the proxy

Cause:

- you launched `claude` directly instead of the wrapper
- your shell still has old proxy variables

Fix:

Run:

```bash
./claude-code-with-proxy.sh claude
```

Or manually export:

```bash
export HTTPS_PROXY=http://127.0.0.1:18443
export HTTP_PROXY=$HTTPS_PROXY
```

And check:

```bash
env | grep -i proxy
```

### Problem 5: your home network is behind CGNAT

This guide does not solve that.

You need:

1. an edge VPS
2. or a reverse tunnel design

That is a different deployment shape.

## Final Checklist

Before you say this setup is done, confirm all of these:

- `wg show` shows a recent handshake on both sides
- `./test-egress.sh` prints your home broadband public IP
- `curl --proxy http://127.0.0.1:18443 -I https://api.anthropic.com` succeeds
- Claude Code works when launched via `./claude-code-with-proxy.sh claude`
- the relay still works when started with the proxy variables or per-account proxy config
