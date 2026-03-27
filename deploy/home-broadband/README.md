# Home Broadband Add-on

This add-on mirrors the working pattern used on the current production host:

`Claude Code / relay -> local tinyproxy -> WireGuard policy route -> home broadband exit`

It is intentionally separate from the relay core. The relay stays clean. The egress stack stays optional.

## Who This Is For

Use this add-on if all of these are true:

- you already have `safe-claude` running on a VPS or relay host
- you want Anthropic traffic to leave through your home broadband instead of the VPS IP
- you can control a Linux machine at home
- you can forward one UDP port on your home router, or you already have another way to reach that home machine

Do not start here if you have not made the relay work in direct mode first.

## Who Should Not Use This First

Stop and use a simpler setup first if any of these are true:

- you have not yet started the relay once in direct mode
- you do not know whether your home network can port-forward UDP
- your home network is behind CGNAT and you do not have an edge VPS or reverse tunnel
- you want a generic Clash/Xray subscription product instead of a relay-side egress path

## What This Add-on Gives You

- a local HTTP proxy for Claude Code and relay outbound traffic
- WireGuard policy routing bound to a dedicated proxy user
- a home-side WireGuard exit template with NAT
- simple test commands to confirm the exit IP
- step-by-step instructions for beginners

## Read Order

Use the documents in this order:

1. [STEP_BY_STEP_ZH.md](./STEP_BY_STEP_ZH.md) if you want the Chinese beginner guide.
2. [STEP_BY_STEP.md](./STEP_BY_STEP.md) if you prefer English.
3. This `README.md` for a shorter overview after you understand the flow.

## Requirements

- Ubuntu on the relay host
- Ubuntu or another Linux host on the home network
- root access on both machines
- router port-forwarding to the home WireGuard host, or another reachable path

If the home network is behind CGNAT and cannot accept inbound WireGuard, this first version is not enough by itself. In that case you need an additional reachable edge VPS or reverse tunnel.

## Files

- `install-relay-host-egress.sh`: install local tinyproxy + optional WireGuard client on the relay host
- `install-home-gateway.sh`: install WireGuard server + NAT on the home-side Linux host
- `generate-wireguard-keys.sh`: generate ready-to-edit env files with fresh keys
- `detect-wan-interface.sh`: print the default outbound interface on the home Linux host
- `relay-host.env.example`: relay-host variables
- `home-gateway.env.example`: home-gateway variables
- `claude-code-with-proxy.sh`: run Claude Code with the local proxy env
- `test-egress.sh`: verify the local proxy and exit IP
- `STEP_BY_STEP.md`: detailed English installation guide
- `STEP_BY_STEP_ZH.md`: detailed Chinese installation guide

## Topology

### Relay Host

- `tinyproxy` listens on `127.0.0.1:${PROXY_PORT}`
- the proxy runs as a dedicated unix user
- only that unix user's traffic is routed into the WireGuard table
- everything else on the box stays on the normal route

### Home Gateway

- `wg-home` listens on the home Linux host
- NAT forwards tunnel traffic to the normal home WAN interface
- Anthropic sees the home broadband exit

## Quick Flow

### 1. Generate WireGuard keys

```bash
cd /home/ubuntu/safe-claude/deploy/home-broadband
./generate-wireguard-keys.sh
```

### 2. Detect the home WAN interface

Run this on the home gateway:

```bash
cd /home/ubuntu/safe-claude/deploy/home-broadband
./detect-wan-interface.sh
```

### 3. Edit the generated env files

- set `WAN_INTERFACE` in `generated/home-gateway.env`
- set `WG_ENDPOINT` in `generated/relay-host.env`

### 4. Install the home gateway side

```bash
cd /home/ubuntu/safe-claude/deploy/home-broadband
set -a
source ./generated/home-gateway.env
set +a
sudo -E ./install-home-gateway.sh
```

### 5. Install the relay side

```bash
cd /home/ubuntu/safe-claude/deploy/home-broadband
set -a
source ./generated/relay-host.env
set +a
sudo -E ./install-relay-host-egress.sh
```

### 6. Test the exit IP

```bash
cd /home/ubuntu/safe-claude/deploy/home-broadband
PROXY_PORT=18443 ./test-egress.sh
```

### 7. Run Claude Code through the local proxy

```bash
cd /home/ubuntu/safe-claude/deploy/home-broadband
./claude-code-with-proxy.sh claude
```

## Using The Same Exit For The Relay Service

You have two clean options.

### Option A: environment variables for the relay process

```bash
export HTTPS_PROXY=http://127.0.0.1:18443
export HTTP_PROXY=$HTTPS_PROXY
npm start
```

### Option B: set a per-account proxy inside the admin UI

If your relay supports account-level proxy configuration, set the Claude account proxy to `127.0.0.1:18443` on the relay host.

This is usually cleaner than forcing the whole machine into the proxy path.

## Engineering Notes

1. This add-on is optimized for the same pattern used on the current server, not for every home-network scenario.
2. The relay core does not depend on this directory.
3. Keep one stable exit identity per Claude account.
4. If you are publishing this repo for others, point beginners to `STEP_BY_STEP_ZH.md` or `STEP_BY_STEP.md`, not to the shell scripts directly.
