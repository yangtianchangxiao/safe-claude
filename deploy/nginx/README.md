# Nginx Domain Add-on

This add-on is the clean, minimal version of the same pattern used on the current production host:

`domain -> nginx -> safe-claude on 127.0.0.1:3000`

Use this when you want:

- a real domain such as `relay.example.com`
- HTTPS instead of raw `http://IP:3000`
- a stable public URL for Claude Code clients

If you only want local testing, skip this directory and use `http://127.0.0.1:3000`.

## Read Order

1. [STEP_BY_STEP_ZH.md](./STEP_BY_STEP_ZH.md)
2. `nginx-site.env.example`
3. `install-nginx-site.sh`
4. `issue-certbot-certificate.sh` if you want Let's Encrypt HTTPS

## Files

- `STEP_BY_STEP_ZH.md`: Chinese hand-holding guide
- `nginx-site.env.example`: variables you fill in
- `render-nginx-site.sh`: generate an Nginx config from variables
- `install-nginx-site.sh`: install the site config into `/etc/nginx`
- `issue-certbot-certificate.sh`: optional helper for Let's Encrypt

## What This Mirrors From Production

The current production host uses the same core idea:

- Nginx listens on `80/443`
- relay itself runs on a local port
- Nginx reverse proxies to the local relay
- public clients use the domain, not the raw Node port

The clean version here keeps only the Claude relay part and removes unrelated Codex/remote-panel paths.
