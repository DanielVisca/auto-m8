# Security

auto-m8 runs agents with your own credentials (your `claude` login, your `gh` login, your browser profile) and can post to GitHub as you. Treat it like a terminal: only run it on a machine you control.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting (Security tab → *Report a vulnerability*). Don't open a public issue for anything that could be exploited. You'll get a reply within a few days.

## What auto-m8 does to stay safe

- The server binds to `127.0.0.1` and rejects any request whose Host or Origin isn't auto-m8 itself, so a web page can't drive it through your browser.
- Phone access is off until you pair a device with a one-time code; each phone gets its own revocable cookie.
- Secrets (API keys) live in the macOS keychain, never in the repo or `settings.json`.
- Autonomy features (shepherd, autopilot, evolve) are **off on a fresh install**. Turn them on knowingly: they run Claude in the background on your subscription and can comment on your PRs.
- No telemetry. Every outbound call uses your own credentials.
