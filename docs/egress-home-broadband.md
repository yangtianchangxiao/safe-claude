# Home Broadband Egress

This repository does not bundle WireGuard, Xray, Clash subscriptions, or residential proxy orchestration into the relay core itself.

It does support Claude traffic leaving through a home or residential connection if you provide that egress layer yourself.

## Read This In The Right Order

Use the document that matches your level:

- If you only want the concept and architecture choices, read this file.
- If you want the same Claude Code proxy pattern used on the production host, go to [deploy/home-broadband/STEP_BY_STEP.md](./deploy/home-broadband/STEP_BY_STEP.md).
- If you want the beginner-friendly Chinese version, use [deploy/home-broadband/STEP_BY_STEP_ZH.md](./deploy/home-broadband/STEP_BY_STEP_ZH.md).

## What The Clean Repo Supports

- per-account proxy configuration in Claude account records
- system-wide `HTTP_PROXY` / `HTTPS_PROXY` fallback for OAuth refresh and token exchange paths
- direct deployment when the host can already reach Anthropic

## What The Clean Repo Does Not Include

- home router setup inside the relay core
- dynamic DNS inside the relay core
- WireGuard server provisioning inside the relay core runtime
- subscription distribution as part of the relay service
- Clash/Xray client management inside the relay runtime

Those belong to your network edge, not the relay core.

The optional `deploy/home-broadband/` add-on exists exactly to keep that boundary clean: the relay stays publishable, and the egress pattern stays optional.

## Pattern 1: Home SOCKS5 Or HTTP Proxy

Use this when you already have a machine on the home network that can expose a stable outbound proxy.

Flow:

`client -> clean relay -> home SOCKS5/HTTP proxy -> Anthropic`

Recommended use:

1. Run a small authenticated proxy on the home side.
2. In the relay admin, set that proxy on the Claude account.
3. Keep only Anthropic traffic on that proxy path. Do not force unrelated admin traffic through it unless needed.

Example proxy object stored on a Claude account:

```json
{
  "type": "socks5",
  "host": "home-proxy.example.com",
  "port": 1080,
  "username": "relay",
  "password": "change-me"
}
```

## Pattern 2: WireGuard Back To Home

Use this when you control both sides and want routing at the network layer instead of per-account proxy config.

Flow:

`client -> clean relay -> WireGuard tunnel -> home gateway -> Anthropic`

Recommended use:

1. Bring up WireGuard between the relay host and a home-side gateway.
2. Add policy routing so only Anthropic traffic goes through the tunnel.
3. Leave Redis, SSH, admin UI, and unrelated outbound traffic on the normal VPS route unless there is a reason not to.

This is usually cleaner than putting the entire server behind a consumer VPN.

If you want an implementation of this exact pattern, use the add-on guide in [deploy/home-broadband/README.md](../deploy/home-broadband/README.md).

## Pattern 3: Dedicated Egress VPS In Front Of Home Broadband

Use this when the home connection is not directly reachable from the internet.

Flow:

`client -> clean relay -> private tunnel/proxy -> edge VPS -> home broadband exit -> Anthropic`

This is more complex. Only use it if direct home-side proxy or direct WireGuard is not practical.

## Engineering Guidance

1. Keep the relay and the egress layer separate.
2. Prefer one stable exit identity per Anthropic account.
3. Avoid mixing Codex/OpenAI/Gemini traffic into the same clean relay distribution.
4. Add monitoring on first-byte latency and upstream failures before blaming the relay.
5. Make the relay work in direct mode first, then add residential egress.

The clean repository is intentionally the relay layer, not the household networking product.
