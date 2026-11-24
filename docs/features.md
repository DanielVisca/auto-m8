# auto-m8: full feature guide

The [README](../README.md) has the short version. This is everything else.

A small window that floats above everything else and holds all your agent work: Claude Code chats and terminals, plus PostHog Code sessions and PostHog tasks (scouts, ReviewHog, your `@PostHog` asks in Slack) if you use PostHog. Search all of it, see which conversations need you and which PRs they opened, and start or continue any of them.

It is a thin layer over tools you already have. Chats run your own `claude` CLI, so they have every connector, MCP server, skill and permission setting your terminal has. auto-m8 builds no connectors of its own.

## Install

You need a Mac, [Node 26+](https://nodejs.org) (`brew install node`), [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup) and the [GitHub CLI](https://cli.github.com) (`brew install gh`).

```sh
git clone https://github.com/DanielVisca/auto-m8.git
cd auto-m8
npm run setup            # or: npm run setup -- --login  (also start auto-m8 when you log in)
```

That installs and builds auto-m8 and puts **auto-m8.app** in `~/Applications`: open it from Spotlight (⌘Space, "auto-m8"). It runs this checkout, so `git pull && npm run build` updates it. Your data lives in `~/Library/Application Support/perch`, never in the repo.

## First run

Home opens with a short setup checklist:

- **Claude Code** and **GitHub**: needed. auto-m8 uses your own logins (`claude`, `gh auth login`); each row has a button.
- **Your name**: agents work for you by name and sign the GitHub comments they post from your account ("🤖 Ana's agent · …"). It comes from `git config user.name`; change it there or in Settings.
- **Your code**: where new chats start, and where auto-m8 looks for repos (`~/Development`, `~/code`, `~/src`, `~/Projects`… whichever exist).
- **Chrome** (optional): agents get their own Chrome window to browse in.
- **PostHog** (optional): a personal API key adds PostHog tasks, the shared skill store, scouts, StampHog and PostHog Review. Without one those parts stay hidden. US, EU or your own host; the project is picked from the key.
- **Let agents act on their own**: off on a new install. On, auto-m8 shepherds the PRs your agents open (answers reviews and red CI), suggests and runs automations, writes skills for things you repeat, and gives quiet chats a closing pass. These run Claude in the background on your subscription.

Everything else (search, chats, terminals, PR status, routines) works as soon as Claude and GitHub are in.

## Run from the checkout

```sh
npm start          # build the UI and open the floating window
npm run app        # open the window (UI already built)
npm run serve      # server only; use http://127.0.0.1:4777 in any browser
npm test && npm run typecheck
```

Toggle the window with **⌃⌥Space** (change it in Settings → Window).

## The window adapts to its size

Drag it and the layout follows:

| Size | Layout |
| --- | --- |
| Shorter than 150px | **Command bar**: running and needs-me counts, plus one line to ask Claude |
| Narrower than 640px | **Compact**: one column; ☰ switches between the list and the open conversation |
| 640–1100px | **Medium**: sidebar and conversation |
| Wider than 1100px | **Wide**: sidebar, conversation, and a details column (PRs, linked conversations, notes, tools used) |

Settings → Window has presets (bar, compact, side, full) and the pin that keeps it above other windows.

| Keys | |
| --- | --- |
| ⌘K | search everything |
| ⌘N / ⌘T | new chat / new terminal |
| ⌘\\ | show or hide the sidebar |
| ⌘I | details column |
| ⌘⇧B, or `/btw …` in the composer | side question |
| ⌘, | settings |

## Finding and organising

- **Search** looks at titles, messages, labels, notes, branches and PR titles. It ranks by relevance, with a boost for what is recent, live and pinned. These filters combine with words and `"phrases"`:

  | Filter | Example |
  | --- | --- |
  | Label, or not | `#label`, `-#label` |
  | Source | `in:claude`, `in:code`, `in:task` |
  | State | `state:waiting` |
  | Repo or PR | `repo:posthog`, `pr:1234` |
  | Project | `project:dash` |
  | Pinned, automated, everything | `is:pinned`, `is:auto`, `is:any` |
  | Age | `older:7d`, `newer:2d` |

  ⌘↵ in the search box, or **✦ Ask Claude**, answers a question from your history. Claude searches and reads your conversations and your live open PRs, then answers with links back.
- **Right-click** any conversation, or a ⌘/⇧-click selection of them, to:
  - mark it Active or Done;
  - snooze it to **Later** (tomorrow, 3 days, next Monday, 2 weeks, next month, or someday); when the time comes it returns as *Needs me* with a ↩;
  - **Archive** it (out of lists, still in search) or **Hide it for good** (out of lists, search and suggestions; `state:hidden` finds it);
  - add labels, with one click to apply the same label to related conversations (same branch, shared PRs, links).

  Writing to a conversation again brings it back to automatic.
- **Needs me** only shows real signals:
  - the agent's last message asks you something;
  - a reply arrived since you last opened it;
  - a PR it opened has failing checks or changes requested;
  - a PostHog task failed;
  - a snooze ended.

  Recent work without a signal is Active.
- **Automated runs** (PR shepherds, scouts, workflows) stay out of the lists under their own *Automated* filter. They link to the PR they work on, and search still finds them.
- **Rules** (Settings → Organising) are saved searches that act every minute: add a label, archive, or snooze. Done conversations archive themselves after 7 days.
- **Home (⌂, ⌘⇧H)**:
  - a brief Claude writes each morning: pick up x, y or z, what's slipping, and suggested workstream labels;
  - Needs you;
  - your open PRs grouped into stacks, with the conversations that touched them;
  - the **notepad**, one free-form note per day, which search and the brief read.

  **Drive** and **Create** modes reorder the page for days spent pushing PRs through versus making new things.
- **Context, behind the scenes.** With context on, a chat is told it can search your history and should do so when you refer to earlier work (a PR, a stack, "like last time"). It names what it pulled in and links the conversations. Turn context off for a clean session.

## Search everywhere (⌕, ⌘⇧K)

There are two tiers on one page.

- **Instant, no AI, no cost:** these sources run in parallel, each with its own time limit:
  - conversations and notes;
  - every git repo on the Mac (ripgrep);
  - Spotlight for documents;
  - installed skills and the skill store;
  - GitHub PRs and issues you're involved in.

  Results are grouped and folded by source. The cheap sources update as you type.
- **The search agent**, for questions (⌘↵ or ✦ Ask), is read-only. Its tools are files and repos (rg, git reads), auto-m8's own tools, Slack, Granola meetings, Google Drive, GitHub, the web, and upstream source it clones into `~/Library/Caches/perch/src`.
  - **Scope first:** it writes a one-line scope (this repo, all local, people and talk, outside) and widens only when it must.
  - **Stale checkouts:** it notices them and reads `origin/main` without touching your working tree.
  - **Modes:** Fast, Balanced or Deep. Auto picks one from the question, and Deep fans out to parallel subagents.
  - **The view stays small:** a scope breadcrumb, one pill per agent with a live step count, steps folded away, and a short answer with citations (files open in Cursor at the line).
  - **Steering while it runs:** Faster, Deeper, Answer now, or your own words.
  - **It learns:** a playbook of tactics is scored by your 👍/👎 and by whether you open what it cites. Tactics earn *active*, losers are retired, and new tactics are proposed from the logs (Settings → Search learning).

## Branches and restore points

Hover any message: **⑂** branches from there, **↺** rewinds to there. Nothing else appears in the UI.
- **A branch** copies the transcript up to that message into a new session (`claude --resume` works on it). It's linked to the original, which isn't changed.
- **Rewind** is a branch you continue in. The original moves to Later.
- **Code follows along.** At the start of every turn of an auto-m8 chat, the working tree (tracked and untracked files) is saved as a git commit under `refs/perch/<conversation>/<turn>`: no branch, no stash entry, no change to your checkout.
  - Rewinding can put the files back as they were. The current state is saved first, so the restore can be undone too.
  - These commits are never signed, so 1Password never prompts.

## Autoresearch

Type `/autoresearch <what to optimise and the command that measures it>` in a chat, or let an agent offer it (`start_autoresearch`).
- An agent makes one focused change per iteration, measures, and reports in the same ` ```autoresearch ` block format as PostHog Desktop.
- It runs in its own git worktree (`../.perch-worktrees/<repo>-<id>`, branch `autoresearch/<id>`), so your checkout is untouched.
- Every improvement is committed.
- A thin strip on the conversation shows the metric over iterations, the best value, and pause, resume and stop.
- It ends at the budget or the target. If it stops reporting, it lands in Needs me.

## Skills and MCPs, on demand

- **Skills:** chats search the PostHog skill store and load a matching skill when they need it (`search_skills`, `use_skill`). Installing the whole store as a plugin adds about 190k tokens to every session, so auto-m8 doesn't.
- **Wished-for MCPs:** when an agent can't answer confidently for lack of a data source, it logs what was missing (`report_missing_capability`). Settings → *Agents wished they had…* groups those wishes. Each comes with the MCP servers your PostHog MCP registry ranks for it (liveness, real usage, success rate).

## Apple Notes

Read-only search over Apple Notes (titles, folders and full text), in search, in chats (`search_notes`), and with "open in Notes" at the note.
- It needs Full Disk Access: Settings → Connections → Apple Notes → Grant access.
- Add the auto-m8 app (`node_modules/electron/dist/Electron.app`) and `node`, then restart auto-m8.

## Folders

The sidebar shows *Recent*, then folders: workstreams the organiser builds from your history (Metrics, MCP analytics, …) and keeps filing new threads into.
- A folder is a label plus an optional saved search.
- Opening one gives a workspace: what needs you there, its open PRs, its threads, and **+ Chat here** (starts in the folder's repo, already labelled).
- Folders you edit become yours: the organiser files into them but never renames or removes them.

## Errors and health

Every failure becomes one plain sentence: what happened and what auto-m8 is doing about it.
- Dropped connections, 429s and 5xx retry with backoff.
- A crash in the UI stays inside its panel, is reported, and retries itself.
- Settings → Health lists what broke recently, how often, and whether it recovered.
- Recurring errors are handed to autopilot.

## From the browser

- **Drop or paste into a chat:**
  - a link or tab from Chrome becomes a chip with live context (a PR shows its state, checks, review and size, and the agent gets its description);
  - any page gets its title;
  - selected text arrives as a quote.
- **Claude in Chrome** (Settings → Chats) lets chats see and drive the browser.

## Focus, phone, autopilot

- **Focus (◎, ⌘⇧F)** narrows everything to one or two areas: the list, Needs me, Home and PR stacks. An area is any search (`#label`, `project:dash`, `repo:charts`, or words), and the picker suggests your labels, busy projects and repos with open PRs. Pinned conversations stay visible, the banner says how many are hidden, and new chats started in focus get the area's label. Focus is stored on the server, so your phone shares it.
- **Phone access** (Settings → Phone access) listens on the Mac's wifi and Tailscale addresses as well as localhost.
  - Nothing reaches it until you pair. *Pair a phone* shows a QR code with a one-time code; the phone gets its own long-lived HttpOnly cookie, which you can revoke from the device list.
  - A phone can't pair other devices or turn phone access on or off.
  - Plain HTTP: use it on networks you trust, or over Tailscale (encrypted, and works anywhere).
  - Long-press replaces right-click. Share → Add to Home Screen installs auto-m8 as an app.
- **Needs me** means the agent asked you something, or the work stalled: it died mid-tool or on a permission prompt, never answered your last message, or ended on an API error. A PostHog task counts if it failed or has made no progress for 45 minutes. Each item says why.
- **Open in ↗** (chat header, details, right-click) jumps to the right place: the Slack thread a task came from, the task in PostHog, PostHog Code, `claude --resume` in Terminal, or the folder in Cursor or Finder.
- **No parallel work.** Every autopilot proposal is checked against your existing threads, Slack asks, scouts and routines first. It is then kept as new, turned into "extend what you have", or dropped. Duplicates (two runs on one PR, the same ask started twice, near-identical routines) become one-click **Consolidate**.
- **Autopilot** (Home) looks at how you work every 6 hours: repeated requests, Slack asks, skills, when you start work, your scouts, and what automation is already running. It proposes automations you turn on with one click, and flags runaway or failing ones.

  It owns what it creates:
  - every run is recorded and followed to its end;
  - a failed or stalled run lands in Needs me;
  - an automation is paused after 3 failures in a row, or after 8 runs in a row that found nothing to do (the babysitter-loop pattern);
  - after a week of watching, one that proves itself becomes *trusted*.

## What it does

- **Every conversation in one list.** Sources:
  - `~/.claude/projects` (Claude Code);
  - PostHog Code's own Claude folder;
  - PostHog tasks created by you, through the tasks API.

  Search is full-text over titles and messages. Sort by activity, age, state, PRs or length.
- **States.** Running and Needs me are worked out for you; Active, Later, Done and Archived you can also set yourself. A state you set sticks (shown with a •) until you set it back to Automatic.
  - **Running:** an agent is working right now. That means a chat auto-m8 is running, a PostHog task that is in progress, or a transcript written to in the last 90 seconds.
  - **Needs me:** the agent finished in the last day; or a PR it opened has failing checks or requested changes; or a task failed.
  - **Active:** touched in the last 4 days.
  - **Idle:** nothing for 4+ days.
  - **Done:** every PR the conversation opened is merged or closed, or you marked it done.
  - **Later** and **Archived:** only when you choose them.
- **PRs per conversation.** PRs the conversation opened (via `gh pr create`, GitHub MCP, or Claude Code's PR link) are kept apart from PRs it only mentioned. Status (open, draft, merged, checks, review) comes from `gh` every minute.
- **Context between conversations.**
  - When you start a chat, conversations that look related appear as you type. *Pull in* adds a short brief of one (where it started, where it ended) to your message and links the two. *Continue there* opens it instead.
  - Turn **context** off for a clean session: no suggestions, and no access to your history.
  - Chats also get a small `auto-m8` MCP server (`search_conversations`, `get_conversation`, `link_conversations`; tools appear as `mcp__auto-m8__<tool>`), so Claude can look things up itself. Replies link conversations as `auto-m8://<id>`; older `perch://<id>` links still open.
  - Links are stored and shown in the details column. Conversations that share a PR are connected implicitly too (`/api/graph`).
- **/btw.** A side question about a conversation that sees everything in it but is never saved into it. It runs as a throwaway fork (`--fork-session --no-session-persistence`), so it also works while the agent is mid-turn.
- **Terminals.** Real PTYs that keep running when you close the tab. *+ claude* opens Claude Code's own UI; ⌘_ on a conversation resumes it there (`claude --resume`).
- **Automations.** A routine sends a prompt on a cron schedule and/or when its webhook is called (the JSON body is appended to the prompt). It can continue one conversation or start a new one each time. Routines run on this machine, so for work that must run while the laptop sleeps, use a PostHog scout.
- **Skills & scouts.**
  - The skill store sorts by new, updated, *top* (your own use of each skill in a time window) or A–Z. You can filter to *mine* (created or owned), and **✦ Ask** describes what you want so Claude picks from the whole catalogue.
  - Install a skill into `~/.claude/skills`, or get the command that installs the whole store.
  - Scouts: search, *mine*, sort by last run, run now, and see recent runs with what each one found.
- **Insights.** Your own usage, from the transcripts:
  - calls and error rate per MCP server and tool;
  - calls per day;
  - projects;
  - when you start work;
  - requests you keep making, which are candidates for a skill, a routine or a scout.
- **Settings.**
  - Theme: system, light or dark.
  - Claude login and its expiry.
  - GitHub.
  - The PostHog key, which lives in the macOS keychain.
  - Every MCP server with its auth state. claude.ai connectors link to claude.ai; local and plugin servers open `claude /mcp` in a terminal to log in.
  - Chat defaults (folder, permission mode, model, Claude in Chrome, idle shutdown).
  - Sources and reindex.

## How it fits together

```
shell/main.cjs      Electron: floating window, hotkey, size presets. Starts the server if needed.
server/main.ts      Node 26, no build step. HTTP + SSE + WebSocket on 127.0.0.1:4777.
  indexer.ts        tails transcript folders into SQLite (FTS5), syncs PostHog tasks and PR status
  transcript.ts     the transcript parser (shared by the index, the chat view and the MCP)
  chat.ts           one long-lived `claude -p --input-format stream-json` per open chat; /btw
  term.ts           node-pty terminals with scrollback
  context.ts        related-conversation search, context briefs, links
  mcp.ts            the `auto-m8` MCP server chats get
  routines.ts       cron + webhooks
  posthog.ts        skills and scouts over the PostHog API
  status.ts         claude / gh / MCP health for Settings
web/src             React UI (Vite). Also works in a normal browser tab.
```

- Data lives in `~/Library/Application Support/perch/` (the folder keeps its pre-rename name): `perch.db` and `settings.json`. Delete `perch.db` to rebuild everything derived; links, states, notes and routines are lost with it.
- Transcripts are never copied. A chat started here is an ordinary Claude Code session: `claude --resume <id>` works on it, and it appears in Claude Code's `/resume`.
- The server binds to 127.0.0.1 and rejects any request whose Host or Origin isn't auto-m8 itself, so a web page can't drive it through your browser. Webhooks are the one exception, and they need the routine's secret.

## Limits worth knowing

- **claude.ai and Claude Desktop chats** are stored on Anthropic's servers with no API, so they can't be listed here. Artifacts open in the browser when a chat links to them.
- **Transcript cleanup:** Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default). Set it higher in `~/.claude/settings.json` to keep history searchable.
- **Each open chat is a `claude` process** (a few hundred MB). Idle ones stop after 20 minutes, and the next message resumes them.
- **Permission mode is fixed per process.** Changing it restarts the session (the history carries over). In `manual` mode, anything that would prompt is denied, and the turn summary says so.
- **Webhooks are local.** To receive GitHub or PostHog webhooks, point a tunnel at `/hooks/<id>`.
- **"What you keep asking"** groups conversations by how they open. Clustering by meaning is the obvious next step.
