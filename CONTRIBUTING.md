# Contributing

Thanks for looking. auto-m8 is a small macOS app: an Electron shell, a Node server (TypeScript, no build step) and a React UI.

## Setup

You need a Mac, Node 26+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup) and the [GitHub CLI](https://cli.github.com).

```sh
git clone https://github.com/DanielVisca/auto-m8.git && cd auto-m8
npm install
npm run serve        # server only: http://127.0.0.1:4777
npm run dev          # server with reload + Vite UI
npm start            # build the UI and open the floating window
```

Point a throwaway copy at its own data with `PERCH_DATA=$(mktemp -d) PERCH_PORT=4799 npm run serve`, so you never touch your real history.

## Before you open a PR

```sh
npm test
npm run typecheck
```

CI runs the same two commands.

## Guidelines

- **Small PRs.** One idea each. Say what hurt before the change and what's different after.
- **Tests with the change.** `server/*.test.ts` use `node:test`; most run against an in-memory database.
- **Personal things are settings.** Don't hardcode a name, org, path or host. See `docs/distributable.md`.
- **Autonomy stays opt-in.** Anything that spends the user's subscription or acts from their accounts must be off by default.
- **UI changes:** include a screenshot.

## Ideas that would help most

- Linux support (the shell and installer are macOS-only today)
- More agent sources besides Claude Code (Codex, Gemini CLI, Aider)
- Sources for PRs and CI beyond GitHub
