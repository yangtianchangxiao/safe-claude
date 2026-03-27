# safe-claude

<p align="right">
  <a href="./README.md">简体中文</a> | <strong>English</strong>
</p>

> People have spent too much time fighting Claude setup.
>
> We want more people to benefit from AI without getting blocked by cost, setup friction, or account risk.
>
> If you want to split the high cost of Claude Code with your crew without turning the account into chaos, or you need a team setup where you can see who used what, `safe-claude` is built for that.

## What this is

`safe-claude` is a self-hosted Claude gateway.

You connect your own Claude account, and it gives you a stable API endpoint for Claude Code or other compatible clients.

## What you can do with it

- run your own Claude endpoint
- add Claude accounts in the admin UI
- create `cr_...` API keys
- issue different keys to different people and track usage per key
- keep team usage in one place instead of everyone wiring their own setup
- point Claude Code to your domain, IP, or localhost
- add proxy egress, home broadband egress, or Nginx later if needed

## Fastest way to start

### One-command install

For Ubuntu / Debian:

```bash
git clone git@github.com:yangtianchangxiao/safe-claude.git
cd safe-claude
sudo ./install-safe-claude.sh
```

The script will:

- install or verify Node.js 18+
- install Redis
- create `.env`
- generate secrets
- install dependencies
- initialize the admin account
- create `safe-claude.service`
- start the service

Then open:

- Admin: `http://YOUR_IP:3000/admin-next/`
- Health: `http://YOUR_IP:3000/health`

If you already have a domain, use that instead:

- `https://relay.example.com/admin-next/`
- `https://relay.example.com/api`

### Manual install

```bash
cp .env.example .env
npm install
npm run setup
npm start
```

## After it starts

Do these steps in order.

1. Open the admin UI.
2. If you plan to use home broadband or residential egress for Claude, set that up before the first Claude login.
3. Add a Claude account.
4. Create a `cr_...` API key.
5. Point Claude Code to your gateway.
6. Test with a small API call.

Important:

- get the site and admin UI working first
- but if Claude should live on home broadband egress, wire that in before you sign in to Claude

Do not log in to Claude on the raw VPS exit first and move it to home broadband later. That increases account risk.

## Claude Code example

With a domain:

```bash
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
export ANTHROPIC_BASE_URL="https://relay.example.com/api"
```

Without a domain yet:

```bash
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
export ANTHROPIC_BASE_URL="http://YOUR_IP:3000/api"
```

Local-only test:

```bash
export ANTHROPIC_AUTH_TOKEN="cr_your_api_key"
export ANTHROPIC_BASE_URL="http://127.0.0.1:3000/api"
```

## Other docs

- Client setup: [docs/CLIENT_SETUP_GUIDE.md](./docs/CLIENT_SETUP_GUIDE.md)
- Home broadband egress: [docs/egress-home-broadband.md](./docs/egress-home-broadband.md)
- Nginx domain setup: [deploy/nginx/STEP_BY_STEP_ZH.md](./deploy/nginx/STEP_BY_STEP_ZH.md)

## Upstream credit

This repo is derived from:

- `https://github.com/Wei-Shaw/claude-relay-service`

Keep the upstream link, MIT license, and `NOTICE` file in public distribution.
