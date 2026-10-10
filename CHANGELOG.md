# Changelog

## 2.0.1

Fixes the saving-mode panel, which 2.0.0 shipped non-functional.

The Host half registered its HTTP route with a one-shot `ctx.get('webServer')`
at apply time. A row activates as soon as its `inject` services exist, and this
row injects only `tools` — which is available earlier than the web server's
listen. In that ordering the lookup returned `undefined`, the route was never
registered, and the panel's fetch 404ed for the life of the process.

The route is now registered through `ctx.inject(['webServer'], …)`, so it is
created when the service arrives regardless of ordering. The integration check
asserts that the plugin acquires the server that way, which is the regression
guard for this defect; the live check caught it as a 404 on the real route.

Everything else in 2.0.0 is unchanged, including the memory document, which was
verified working in the same live check.

## 2.0.0

Two new capabilities on top of 1.0.0's source-side compression. Both are
switchable, and everything from 1.0.0 keeps working unchanged.

### The saving-mode panel

A pill under the composer (`conversation.composer.dock`) opens a list of the
nine savings and lets you turn each one on or off:

| Mode | What it does |
|---|---|
| `terminal` | Strip ANSI escapes and carriage-return repaints. |
| `columns` | Collapse alignment padding, keeping indentation. |
| `repeatedLines` | Fold runs of identical lines into a count. |
| `numericRuns` | Fold build counters and timestamps into a range. |
| `json` | Minify JSON; tabulate homogeneous arrays. |
| `elide` | Bound oversized results; every cut names a recovery path. |
| `catalogue` | Apply `hiddenTools` (offered only when the patch sets some). |
| `memo` | Record the workspace memory document. |
| `recall` | Match that document and inject the hits. |

A change applies to the live session immediately and is written to
`dsh-token-frugal.state.json` next to the profile, so the patch is never
rewritten and a restart keeps the choice. `catalogue` is re-applied to agents
that already exist, not only to new ones.

The Client half is a lazy module registered with the page's module loader; it
reaches the Host half over one exact HTTP route, because `host.call` belongs to
the sandboxed dynamic-package mechanism and a profile-installed bundle cannot
use it. Visible text follows the active locale; every colour comes from a
`--dsw-alias-*` theme token.

### The workspace memory document

One markdown file per workspace, one `## session` section per conversation, one
`### ` block per recorded item:

- **your messages verbatim** — a future query resembles a past input far more
  closely than it resembles a summary of one;
- **a turn digest** drawn from the reply — bullets and conclusion-shaped lines,
  falling back to the opening sentence, never quoting fenced code.

Recording costs no model tokens: the digest is extractive, not generated.

The path is relative to the session's workspace (default
`.dsh-token-frugal/memory.md`), so the record travels with the work.

### Recall

A new user message is tokenized (Latin words plus CJK bigrams, so Chinese
matches without a segmenter) and scored against the document's blocks with
term frequency weighted by inverse document frequency, a boost for your own
verbatim wording, and length damping so a long block cannot win on size alone.

What gets injected is bounded by `recall.maxChars`, requires at least
`minMatchedTerms` distinct matches so one shared word cannot spend tokens on an
irrelevant extract, and is delivered with `agent.inject()` — an
`agent/inbox/spliced` event that **appends** to the request instead of rewriting
it, so the provider's prefix cache survives. Blocks recorded in the current turn
are never quoted back (they are already in the transcript), notes from other
conversations in the workspace are preferred, and the same extracts are never
injected twice in a row.

### Also changed

- The module now imports Node builtins (`node:fs`, `node:crypto`, `node:path`)
  but still no Harness package. Because it imports nothing external, the
  integration check no longer needs to read the core packages out of the
  installed `app.asar` — `node test/load-check.mjs` runs anywhere.
- `tools/measure-tokens.mjs` understands inline YAML maps, which is how the new
  one-line overrides (`modes: {}`) are written.
- `resolveConfig` validates four new nested setting groups and reports an
  unknown key inside any of them.

### Upgrading from 1.0.0

Nothing to do. Every 1.0.0 key still means what it meant, and each new mode
starts from the value its old key implies (`elide` from `recovery`, `catalogue`
from `hiddenTools`). The running Harness must be restarted once to load the new
module generation: a profile-installed bundle is cached per process, so a
disable/enable cycle alone keeps executing the old code.

## 1.0.0

Source-side tool-output compression on `tools/post-execute`, per-agent
tool-catalogue visibility on `agent/created`, and a measurement script. 41.76%
fewer prompt tokens over 149 recorded requests on the corpus it was tuned
against; `README.md` records the methodology and the per-session spread.
