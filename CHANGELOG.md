# Changelog


## 2.2.0

**A result that stopped being new is now re-sent as a digest of itself.**

The deeper tiers used to cut only at arrival: the budget a tool result was handed
when it came back was the budget it kept for the rest of the session. In a long
session that is the wrong shape — the newest results are the ones a model still
reasons from, the older ones are context it rarely returns to. On the deep and
extreme tiers, a result that has fallen out of the newest two (or the newest one)
is now replaced, for the model only, by a head-and-tail digest carrying the same
recovery hint an arrival-time elision carries.

| Tier | Kept whole | Older results | Billed prompt tokens removed |
|---|---|---|---|
| 标准 `standard` | every result | untouched | 21.8% |
| 深度 `deep` | newest 2 | 300-character digest | 29.5% |
| 极限 `extreme` | newest 1 | 200-character digest | 32.1% |

- **Nothing is lost.** The replacement is a `surfaceOp: replace` over the original
  `tool/result` node, which `dsh-session` restricts to exactly that: the durable
  log, the transcript, the memory document and the statistics keep the original
  text. Only the request the model reads is shorter — and it is committed on
  `agent/pre-step`, before the step that reads it.
- **The constants are measured.** `tools/measure-tokens.mjs` now models aging the
  way the provider bills it: every digest lands in old history, so it invalidates
  the cached prefix from that point on. That re-prefill cost is why the shipped
  rule keeps as much whole as it does and why the digest is short — `keepFull` at
  three or more is a net loss, and the first cut at this feature (newest 3 whole,
  600-character digests) priced at 25.5%, worse than no aging at all.
- **A budget that cannot carry its marker no longer elides.** A marker cut off
  mid-sentence reads as damage rather than as a pointer back, so `elideToBudget`
  now refuses a budget below its own marker instead of emitting a truncated one.
- **New measurement flags:** `--aging-keep`, `--aging-limit`, `--no-aging`, and
  a `--depth` that now prices the shipped aging rule.
- **New counters:** the stats page's 时效替换 / *Aged digests* row counts digests
  separately from arrival rewrites, per process and cumulative.

## 2.1.0

One new control, on the grade that already asked for a deliberate choice. The 高等
grade now carries the **elision depth**: three budget tables for how hard a long
tool result is cut, measured end to end rather than asserted.

**The biggest lever this plugin has was a constant, and is now a choice.** A tool
result is re-sent on every later request in its session, so one character removed
at the source is worth roughly 250 characters of prompt — which is why the
per-tool character budget dominates everything else. The panel exposes three
tiers of that table, all priced with `tools/measure-tokens.mjs` over one corpus
(1946 requests across the 13 replayed sessions, modes at their shipped defaults):

| Tier | Tool-result characters removed | Prompt tokens removed |
|---|---|---|
| 标准 `standard` | 46.9% | 22.0% |
| 深度 `deep` | 63.3% | 27.6% |
| 极限 `extreme` | 77.0% | 31.9% |

`standard` is what earlier versions always did, and is still the default: a
profile that never opens the selector behaves exactly as before. `deep` and
`extreme` override `defaultMaxChars` and the budgets of the tools that produce
the bulk of the context (`read`, `web_fetch`, `web_search`, `pwsh`, `bash`,
`grep`, `glob`). Those entries override the configured table rather than
replacing it, so a tool the tier does not name keeps the number the profile gave
it, and `standard` is the profile's own table unchanged.

**A tier is a budget table, not a switch, and the host is the only authority on
it.** The bridge accepts `{"modes":{...},"depth":"extreme"}`; an unknown tier is
refused with a 400 rather than silently falling back to one the panel did not ask
for, and the response carries the tier the host actually applied together with
the previous one. The choice is persisted as `elisionDepth` beside the modes in
`dsh-token-frugal.state.json` (state schema 2). A state file written by 2.0.5 is
still read — its modes apply, and it is interpreted as `standard` — because
losing a user's switches to a schema bump would be the worse failure.

**Nothing about the trade-offs changed.** A tier only moves budgets: it never
changes which transforms run, and it never lets `elide` drop a result it cannot
hand back, so an unrecoverable result stays whole at every tier. `--depth
<standard|deep|extreme>` on `tools/measure-tokens.mjs` prices whichever table the
panel applies, so the three rows above are one command each rather than three
hand-written `--budgets` lines.

## 2.0.5

One fix, in the only place this plugin writes *into* the conversation rather than
around it. Recall was crashing the page; it now carries the message source every
durable message is required to have.

**The recall injection had no `source`, and the Harness reads `source.kind`
unguarded.** `agent.inject()` hands its message straight to the next-step inbox,
and three separate readers dereference `message.source.kind` without checking
that `source` exists at all: the `@deepseek-ai/dsh-webhook` relationship
invariant over every `agent/inbox/spliced` event
(`dsh-webhook/lib/invariant.js:14`), `isOwned()` in the agent loop over every
`user/message` (`dsh-agent-loop/lib/index.js:221`), and — the one that blanks
the window — the Chat inbox filter inside a React `useMemo`
(`dsh-client-ui-chat/lib/client.js:5187`), which threw while rendering and took
the whole tree down with it. `dsh-session` refuses the message outright as well
(`${subject} message has invalid source`, `dsh-session/lib/index.js:1202`), and
the session format requires a *producer-owned* kind. The injected message now
carries `source: { kind: 'token-frugal-recall' }`.

**The test now enforces that contract.** The fake agent in
`test/load-check.mjs` accepted any object, which is exactly why a source-less
message passed locally and failed in the app — the mock is now as strict as
`dsh-session`, asserting a nonempty string `source.kind` on every injected
message plus the exact kind value. Replaying the three unguarded reads against
the message recorded in the crashed session's own log reproduces `TypeError:
Cannot read properties of undefined (reading 'kind')` for 2.0.4 and passes for
2.0.5.

**The plugin no longer mistakes its own carrier for user input.** The kind is
also what makes the injection addressable. `inject()` appends to the next-step
inbox, and `Inbox.claim()` hands every claimed message — including that one —
back through `agent/inbox/claimed` at the next step boundary. The recall handler
ignored that fact, so a healthy turn would have recorded the whole
`<recalled-context>` block into the memory document as though the human had
typed it, and then matched recall against that copy. The handler now returns
early on `source.kind === 'token-frugal-recall'`. `test/load-check.mjs` replays
the claim and asserts that the carrier triggers no second injection and never
reaches the memory document.

## 2.0.4

Two changes: a statistics page that reports what was saved, and a panel whose copy
is precise and whose nine switches are grouped into three grades. No compression,
catalogue, or memory behaviour changed.

**A statistics page inside Settings.** The Host half now keeps a running record —
tool results inspected and rewritten, characters removed, the estimated token
value of them, a per-tool breakdown, catalogue savings, recall injections, and
spill failures — and serves it from a second exact route derived from the same
bridge key (`/dsh-token-frugal/stats`, so a profile that moves the bridge moves
both). `lib/stats.js` holds the record: `recordCall/recordRewrite/recordRecall/
recordCatalogue/recordSpillFailure` mutate a counter object, `summarizeStats`
prices it at the Harness's own 4-characters-per-token heuristic, and the
cumulative half is persisted next to the mode state at most once every five
seconds. The page renders that record: an all-time hero figure, the current
process beside the all-time total, the per-tool table, and a two-step "clear
all-time record" that leaves the running process figures alone.

The catalogue figure is per request, not a total: while the tool-catalogue
restriction is active, every request the agent makes is missing those schemas, so
"2 tools hidden · about 900 tokens per request" is the only honest way to print
it.

**Persistence now reaches the profile the app actually runs in.** Both records are
written beside the profile, but the app process exports none of `DSH_PROFILE_DIR`,
`DSH_HOME`, or `DSH_PROFILE` (the tool calls it spawns do), so `stateDirectory()`
returned `undefined` and every choice was session-only. It now falls back to the
single profile under `~/.dsh/profiles` that either holds this package or already
holds a `dsh-token-frugal` file; two candidates yield no directory at all, because
scattering state across profiles is worse than not persisting. The panel keeps
working either way, and the statistics page labels an unpersisted all-time half
instead of showing an incomplete total as if it were complete.

**The panel speaks precisely, in three grades.** The nine switches were a flat
list named in everyday words ("colour codes", "rising numbers", "hide tools")
that hid what each one actually does. They are now grouped by what a wrong choice
costs — 初等 (`terminal`, `columns`, `json`) is lossless by construction, 中等
(`repeatedLines`, `numericRuns`) folds structure that the text itself encodes,
高等 (`elide`, `catalogue`, `memo`, `recall`) either drops content or changes what
the model is shown — and each mode states the exact thing it removes or folds,
plus whether the change is reversible. The card is an accordion: opening one
grade closes the others, so the panel is never taller than one grade, and each
grade carries a one-click set-all control.

The panel is wider than the pill it replaced, so the integration check now also
proves that the three grades cover every mode exactly once: the panel renders the
grades, not the mode list, so a mode left out of the grade table would vanish
from the UI with no other symptom.

`client.js` now declares `@deepseek-ai/dsh-client-runtime` and
`@deepseek-ai/dsh-client-ui-slots` in `dsh.client.inject`, because the settings
page mounts into `settings.section`, which the slots package owns.

**A listener that returns nothing no longer breaks the tool pipeline.** The
`tools/post-execute` waterfall hands every listener the decision its neighbours
returned, and the Host's own listeners read `.kind` off that value
(`dsh-spill-policy` registers with `{ prepend: true }`, so it sees whatever the
listeners inside it produced). A sibling listener that returns `undefined` —
legal for a Cordis hook, and something this plugin has to survive either way —
made that read throw `Cannot read properties of undefined (reading 'kind')`,
which is the `gateway/internal` failure reported from a profile install. The hook
now restores the discriminator the pipeline requires (the same
`{ kind: 'accept' }` the pipeline's own terminal returns) instead of trusting the
awaited value, keeps every field a sibling did return, and passes the repaired
decision outward, so one misbehaving listener can neither crash this plugin nor
the listeners registered before it. The integration check drives the hook with a
`next` that resolves `undefined`, with `null`, and with a decision that carries no
`kind`, and asserts the repaired result.

## 2.0.3

A layout fix: the mode grid is three columns.

`repeat(auto-fit, minmax(215px, 1fr))` collapses to a single track when the
container has no definite width, and the panel's dock wrapper is exactly that
case -- it sizes to its content, so the nine modes still stacked in one column.
The expanded surface now carries an explicit width
(`min(640px, calc(100vw - 48px))`, capped at `100%`) and the grid uses a fixed
`repeat(3, minmax(0, 1fr))` template: three columns on a normal window, and on a
narrow one the columns get narrower instead of overflowing.

The integration check now asserts the exact three-track template and that the
surface carries a definite `min(...)` width, so a return to a single column
fails the build.

## 2.0.2

A presentation release: the panel speaks plainly and lays its modes out in
columns. No compression, catalogue, or memory behaviour changed.

The nine modes had been named after their implementations — "terminal control
codes", "numeric-run folding" — each with a line of developer prose, and the
expanded panel stacked all nine in one column, so it read as a wall of small
boxes. Each mode now says what it does in everyday words ("colour codes",
"rising numbers", "trim long output", "hide tools"), and the modes sit in a grid
(`repeat(auto-fit, minmax(215px, 1fr))`) inside a single surface: two columns at
the panel's usual width, three when there is room.

The panel's copy is pinned to Chinese by `PANEL_LOCALE` in `client.js`; the
English dictionary stays in the same table, so switching back is a one-line
change.

The integration check now actually renders the panel with a stub React and
asserts nine switches, a `display: grid` container with a `minmax` column
template, the Chinese copy, and that `client.js` holds no U+FFFD replacement
character. A lossy re-encode of that file — which had silently corrupted the
panel once — now fails the check instead of reaching the browser.

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
