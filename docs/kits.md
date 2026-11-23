# Kits: start clean or import someone's setup

Goal: a new auto-m8 user picks **Clean** (today's fresh install) or imports a **kit**, e.g. the maintainer's skills, routines, scouts and boards, and gets them working under their own name, paths and accounts.

("Packs" already means feature toggles in distributable.md, so these are called kits.)

## What a kit holds

```
kit.json            name, author, version, description, required: [github, posthog?, grafana?, slack?]
skills/<name>/      SKILL.md + files, copied into ~/.claude/skills/
routines.json       name, cron, prompt, mode; imported disabled
scouts.json         PostHog scout configs; created disabled with emit off (needs a PostHog key)
boards/<id>.json    canvases + tiles
instructions.md     CLAUDE.md snippet, appended under a marked heading so it can be removed
```

Everything personal is a template variable, filled in on import from the Owner setting:
`{{owner.name}}`, `{{owner.github}}`, `{{owner.signature}}`, `{{codeDir}}`, `{{posthog.projectId}}`, `{{blogDir}}`.
Export replaces the maintainer's literal values with these and **fails** if a scrub pattern is still present (name, email, home path, Slack ids, internal hosts, project ids).

## Tiers (the maintainer's setup, 2026-11-19)

| Tier | Where it lives | Examples |
|---|---|---|
| General: works for anyone with Claude + gh | public kit, git repo | caveman, gh-stack, plannotator-*, pr-audit, awareness-review, ddia-swarm, engineering-design-review, feedback-to-prs, model-races, blog-workshop, standup, start-of-day, draft-slack-message, resume-stalled-work |
| PostHog engineer | PostHog skill store + project 2 scouts (already shareable, internal) | get-stamp, preflight, pr-sweep, pr-slicing, shepherd-prs-to-merge, verify-pr-production-deploy, ship-flagged-feature, create-test-scouts, investigate-ingestion-alerts |
| Maintainer-only | not exported | plan-metrics-ingestion, metrics flags/parity, dashboards-v2-*, observability-dashboards-design, fix-grafana-dashboards, hackathon-demo-prep, review-as-me |

Roughly 58 skills, 10 local routines (7 enabled), ~12 scouts in project 2, 12 boards, 38 forged (Evolve) skills.
Evolve-forged skills are learned from one person's chats, so they export only when the user picks them.

## Import flow

1. Settings → Kits → paste a git URL or pick a file. Show every item with its tier and requirement (needs PostHog key, needs Grafana).
2. Preview: rendered prompts with the user's values filled in; name clashes with existing skills shown, kept by default.
3. Install: skills copied, routines and scouts created **disabled**, `kit_items` row per item (kit, version, item, hash) so it can be updated or removed cleanly.
4. Update: re-import a newer version, only items the user hasn't edited (hash matches) are replaced.
5. Remove kit: deletes exactly what it installed.

Nothing runs or spends tokens until the user turns it on; autonomy pack rules still apply.

## Use

```
# export (forbid list: one pattern per line, /regex/flags allowed; keep it outside the repo)
node server/kitcli.ts export --name my-kit --out ../my-kit --author <github> --description "..." \
  --skills a,b --routines "Routine one,Routine two" --instructions snippet.md \
  --forbid ~/.config/auto-m8/kit-forbid.txt --sub="--owner=[[Acme]]=github.org"
# import / inspect / undo
node server/kitcli.ts import <folder or git URL> [--dry-run] [--only skill:a,routine:B]
node server/kitcli.ts list
node server/kitcli.ts remove my-kit
```

`--sub "Literal=var"` adds a substitution; `[[...]]` swaps only that part of a longer match. Variables: owner.name, home, codeDir, github.org, posthog.projectId.

## Status

- [x] Export with templating and scrub gate (`server/kitexport.ts`, `server/kitcli.ts`)
- [x] Import: preview, kit_items record, update without overwriting edits, remove (`server/kits.ts`)
- [x] Settings → Kits (`web/src/Kits.tsx`), `/api/kits*`
- [ ] Scouts and boards (need a PostHog key / canvas export)
- [ ] Publish the maintainer's general kit as its own repo
