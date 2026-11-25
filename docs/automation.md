# What auto-m8 automates, and how it grows

auto-m8 is built so you stop being the thing your agents wait on. Some of that works on day one. The rest grows from how you work: when you hand agents the same job again and again, auto-m8 turns that job into a skill, then into a schedule. All examples below are real, from the author's own install over six weeks (Oct 13 – Nov 24, 2026).

## Out of the box

These need no history: sign in to Claude and GitHub, and turn on **Let agents act on their own** in Settings (it's off on a new install, because it runs Claude in the background on your subscription). Needs me and follow-ups work even with it off.

| You used to… | auto-m8 now… |
|---|---|
| Watch every PR you opened for review comments, red CI and approvals | **Shepherds it.** It answers review threads, fixes red CI, merges when the PR's plan allows it, then checks it in production after deploy. |
| Notice when an agent stopped halfway | **Puts it in Needs me**, with the reason: it died mid-tool, hit a permission prompt, asked you something, or went quiet. |
| Remember to come back to a chat later | **Follows up.** An agent can't promise "I'll check later": it schedules a follow-up and auto-m8 wakes it. |
| Re-explain context in every new chat | **Suggests related conversations** as you type, and agents can search your history themselves. |
| Babysit your automations | **Owns every run.** A run that fails or stalls lands in Needs me. An automation that fails 3 times in a row, or finds nothing to do 8 times in a row, is paused. |

## After you do something a few times: skills

**Evolve** (Skills & scouts → Evolve) reads every ask you make to an agent. It groups the asks into jobs ("shepherd my PRs", "draft a Slack reply") and tracks how each ask ended: answered, corrected, or dropped.

1. **Write.** When a job has come up at least 3 times across at least 3 conversations, and no existing skill covers it, auto-m8 writes one. It learns from your conversations: the steps that worked, the tools used, and above all what you corrected.
2. **Tune.** It keeps checking each skill it wrote. If the job keeps coming up but agents don't load the skill, it rewrites the description using the phrasings that missed. If sessions that load it keep getting corrected, it turns each correction into a rule.
3. **Retire.** A skill nobody has needed for 30 days is moved out. Every version is kept and can be rolled back.
4. **Resume.** Work an agent dropped is picked back up.

In six weeks, from 1,738 asks across 778 conversations, it wrote 44 skills, made 25 rewrites, skipped 3 jobs that had no repeatable steps, and resumed 35 pieces of dropped work.

| Job | Asks | Skill written | What happened next |
|---|---|---|---|
| Building auto-m8 itself | 307 | `perch-perch-app-dev`, from 4 conversations | Loaded in 87 conversations. No rewrites needed. |
| Shepherding PRs to merge | 381 | `perch-shepherd-prs-to-merge` | Rewritten 7 times as new phrasings went unloaded: a bare PR link, "it's approved, why isn't it merged?", stacks to restack. It still loads too rarely, which is why it keeps getting rewritten. |
| Checking a merged PR reached production | 27 | `perch-verify-pr-production-deploy` | Loaded in 15 conversations. Became the procedure the shepherd runs after a merge. |
| Creating and testing scouts | 27 | `perch-create-test-scouts` | Loaded in 11 conversations. Used to build and dry-run the scouts below. |
| Finishing dropped work | 45 | `perch-resume-stalled-work` | Rewritten to trigger on the one-line prompt the cloud runs send. |
| Drafting a Slack reply | 30 | `perch-draft-slack-message` | Rewritten twice, to trigger on short asks like "whats my answer to him?". It never sends: you do. |

One thing to watch: how often a job comes up is not the same as how often its skill gets loaded. The Evolve page shows both for every skill, so you can see which ones are doing their job.

## After a skill proves itself: schedules

**Autopilot** reads the same jobs every 6 hours, plus your routines, scouts and recent runs. When a job happens on a rhythm (every morning, every Monday, after every merge), it proposes a schedule that does it before you ask. You turn it on with one click. It checks first that nothing you already run covers it, so you don't end up with two jobs doing the same thing.

Proposed by Autopilot and turned on:

| Routine | When | Built on |
|---|---|---|
| Weekday standup draft | 09:15 weekdays | `perch-write-standup-summary` |
| Stalled work check | 10:30 weekdays | `perch-resume-stalled-work` |
| Metrics ingestion weekly status | Mondays 09:00 | `perch-plan-metrics-ingestion` |
| Weekly agent usage and bottleneck report | Fridays 16:00 | your history |
| Review-request digest | twice a weekday | `gh` (since turned off) |

Autopilot also pauses what doesn't work. "Morning alert triage" paused itself after 3 failed runs in a row, and nothing kept running unwatched.

## Local routine or PostHog scout?

Both run a prompt on a schedule. The difference is where it runs.

| Use a **local routine** when the job needs… | Use a **PostHog scout** when the job… |
|---|---|
| your machine: local repos, files, a screen recording | must run while your laptop sleeps |
| your signed-in browser, or tools only your machine can reach (a VPN, Tailscale) | only needs PostHog data, GitHub and the web |
| your private notes, which should stay on your disk | should be visible to, or shared with, your team |

Real examples:
- **Local only.** *Shipped today montage* (17:00) records the day's merged changes running in production and cuts a video: it needs the screen and the browser. *Private blog workshop* writes to a folder on disk that never leaves the machine.
- **Scout only.** The alert-gaps, abandoned-experiments and cost-savings scouts read PostHog data and GitHub on a schedule, laptop or not. Their findings can start small fix PRs through a PostHog workflow.
- **Both, as partners.** The adoption, design-review and build-on-primitives scouts run in PostHog on schedule. A local partner routine runs a day later to do what the cloud run couldn't, such as reaching internal dashboards or the signed-in browser, and to repair the scout if it failed.

## How it takes you out of the loop

The pattern is the same every time:

1. **You do it by hand** a few times. auto-m8 records the asks and how they ended.
2. **It writes a skill**, so any agent does the job your way the first time, without you correcting it.
3. **It tunes the skill** from the asks it missed and the corrections you made.
4. **It schedules it**, so the job is done before you think to ask.
5. **It watches the schedule**, so a broken one is paused and shows up in Needs me instead of failing silently.

What's left for you is what only you can do: decide, approve, and send. Agents record those as Needs me items and keep the rest moving.
