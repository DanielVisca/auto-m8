# Making perch shareable

Goal: anyone on a Mac with Claude Code can install perch and have it just work, without changing how the maintainer's perch behaves.

Rule: everything personal becomes a setting. the maintainer's existing `settings.json` gets today's values, so their perch behaves the same; a fresh install gets neutral defaults.

## What a fresh user hits today (tested 2026-11-12: empty HOME, own data dir, port 4799)

- First open: an empty "What are we working on?" page. Nothing says Claude isn't found or GitHub isn't logged in.
- Setup state only lives in Settings → Connections (Claude, GitHub, PostHog key, Apple Notes).
- Health shows 3 errors before the user does anything: the brief spawns `claude` (ENOENT), and the GitHub PR jobs fail because gh isn't logged in.
- `npm run setup` is good: it checks Node, claude and gh, builds, and makes ~/Applications/perch.app. But the README clones a private repo over SSH and documents PostHog features.

## What's tied to the maintainer

1. **Identity in prompts:** the chat system prompt ("the maintainer owns the outcome", "you post from the maintainer's account"), the signhook ("🤖 the maintainer's agent"), browser/browsertool text, orchestra (`/needs the maintainer/` regex), overlay, railyard.
2. **Autonomy on by default, no opt-in:** the shepherd (comments and labels stamphog from the user's GitHub account on any Claude-made PR), autopilot, evolve (writes `~/.claude/skills/perch-*`), lifecycle, organizer, self-fix. Many spawn `claude` in the background, which spends the user's subscription.
3. **PostHog as the backend:** `posthog.projectId: 2` and us.posthog.com, with no UI to change them. Skills store, scouts, tasks, stamphog, proof scorecard and Railyard break or stay empty. The PostHog Code source is on by default.
4. **Paths and hardware:** `~/Development` (chat cwd, PR checkouts, code search, self-fix), "15 cores, 48 GB, 6 worktrees" in prompts.
5. **Small things:** a hardcoded Slack workspace id, PostHog-specific bot lists in journey.ts, `PostHog/posthog` repo filters in proof/railyard/prflow.

No telemetry; every outbound call uses the user's own credentials.

## Plan

1. **Owner setting** `owner: { name, github, org, signature, cores, memGb, maxWorktrees }`. Prompts and the signhook read it. On first start: fill it from `gh api user` / `claude auth status` / `os.cpus()`/`os.totalmem()`. A one-time migration writes the maintainer's current values when an existing settings.json predates it.
2. **Packs**
   - Core (always): chats, search, PRs, terminals, routines.
   - PostHog pack: tasks, skill store, scouts, stamphog, proof, Railyard, PostHog Code source. On when a PostHog key works for the configured host and project.
   - Autonomy pack: shepherd, autopilot, evolve, self-fix, lifecycle, organizer. Off for new installs, with one switch that says what it spends. On for existing installs.
   - Background `claude` jobs wait until Claude is logged in.
3. **First-run checklist** on Home while anything required is missing: Claude, GitHub, code folders (instead of assuming `~/Development`), Chrome; then optional PostHog, Grafana, Slack, Notes. One-click fixes; hidden once green.
4. **Install:** a public repo or a signed .app, a README for new users, and a fresh-user smoke test (the sandbox run above) in the test suite.

## Status

- [x] Investigation (this doc)
- [x] 1. Owner setting (branch `shareable`)
- [x] 2. Packs: autonomy switch (off for fresh installs, on for existing). PostHog: project picked from the key on fresh installs, host/project in Settings, PR-menu cloud actions, StampHog, Review and the skill store hidden without a key, prompts mention PostHog only with a key. Setup gaps stay out of Health.
- [x] 3. First-run checklist on Home (Setup.tsx), plus Settings → You and your agents
- [x] 4. README install + first run (https clone); fresh-user test (server/fresh.test.ts). Still open: public repo or signed .app; Railyard/proof stay PostHog-shaped (empty without a key)
