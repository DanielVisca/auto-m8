# Product research

Open **Product research** in Perch, or `http://127.0.0.1:4777/#products`.
This is the first working slice of a persistent product investigation agent. The
agent explores through Perch's browser and calls `product_research` to preserve
its inventory and evidence. It does not blindly click every control.

## Current workflow

1. `seed` creates the APM inventory for Datadog, Better Stack and PostHog, with
   Grafana Play as an account-free application trial. Seeding is idempotent.
2. `product` records URL roots, scope, account tier, role, region and workload.
   Use `sandbox: true` for local fixtures. Configure the actual regional app URL
   when accounts arrive. Dedicated test accounts should be used for writes.
3. `next` reads queued items and blockers. `item` adds pages, features and
   workflows with stable keys. `parent_id` forms the sitemap; `capability`
   connects equivalent tasks across products. The saved queue survives restarts.
4. `visit` opens the item and begins its interaction history. Use `browser` to
   inspect, fill forms, open dialogs and exercise meaningful states. `discover`
   adds a bounded set of in-scope links; the agent must prioritize them and add
   states or controls that do not have their own URLs. Query-string and fragment
   variants are deliberately not queued automatically; add important ones with
   an explicit state key.
5. `capture` takes a screenshot, visible text, browser snapshot, steps, timestamp,
   context and environment. Supply an accurate `summary`, optional `friction`,
   and `expect_text` only when verifying a completed workflow. Expected text is
   checked in the visible page text; failed checks create no passing evidence.
   Begin with another `visit` if the server restarted during a workflow.
6. `measure` repeats navigation and measures when expected content is painted,
   with an observer installed before page scripts run. Supply `conditions`
   (machine/network/region/data/time range). Raw samples, failures, median and
   range are stored. Model thinking, tool latency and browser settling are not
   included. Existing cache is retained; these are not cold-cache benchmarks.
7. Record blockers with `item status=blocked notes=...`, and resume with
   `status=queued`. `not_found` records where the agent looked, not an absence
   claim. Every successful observation remains in history. Use `detail` to read
   evidence and the UI's export to retain the structured study.

Docs evidence never counts as tested behavior. Sandbox results are excluded
from product comparisons. Benchmarks never promote an item to tested. A checked
string proves only the recorded outcome; agents must inspect the actual workflow
and record what that check does and does not establish. An empty queue is not a
claim of complete coverage.

## Storage and access

- `research_products`, `research_items`, `research_evidence` in Perch's database.
- Screenshots in `PERCH_DATA/product-research/`, separate from the disposable
  browser recordings. JSON export references their evidence IDs; it is not a
  self-contained screenshot archive.
- API: `/api/product-research`, `/items/:id`, `/evidence/:id/image`, `/export`,
  and POST `/api/product-research/tool` with the same arguments as the MCP tool.
- Existing HTTP Host/Origin checks protect every route. Existing browser policy,
  manual takeover and approval gates still apply. Research cannot type passwords.
- Capture refuses login/credential forms and sensitive URL parameters. Editable
  values are hidden in screenshots, step input values omitted, and known token
  patterns scrubbed from text. This is not comprehensive secret detection: do not
  capture API-key or billing pages, and use synthetic account data. Screenshots
  can contain application-rendered data.
- Browser sessions currently share Perch's Agent Chrome profile. Account-isolated
  profiles and credential provisioning are not implemented in this slice.

## Account-free validation

`server/productresearch.test.ts` checks evidence semantics, URL scope, bounded
discovery, queue resume and parent constraints. `server/productresearchbrowser.test.ts`
launches an isolated Chrome profile against a local fixture and checks form
submission, persistence after reload, screenshot creation, rejected outcomes,
credential walls and native timing instrumentation.

`scripts/product-research-lab.mjs` is a disposable local application with onboarding,
trace filtering and a detail dialog, validation errors, and persistent alerts.
It generates no external telemetry and is not evidence about vendor products.

## Next milestones

- Account-isolated browser contexts, signup mailbox integration and credential
  handoffs; limited signup or billing actions only within granted authorization.
- A multi-service OpenTelemetry workload, controlled faults, ingestion verification
  and vendor-specific instrumentation where the shared setup misses features.
- Repeatable interaction benchmarks, cold/warm cache controls and ingest-to-visible
  timings. Only compare equivalent scenarios, roles, datasets and regions.
- Explicit run scheduling, budgets, state reset/cleanup and change detection.
  Currently the agent drives a checkpointed queue during a conversation; there is
  no autonomous background crawler or scheduled re-investigation.
- More complete state graphs, role/tier variants, screenshot annotations,
  portable image archives and evidence-backed comparison synthesis.

Origin: a perch conversation.
