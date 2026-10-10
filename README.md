！！！v2.0.1插件会出现某些不可控的问题

# dsh-token-frugal

Cut the input-token cost of a long DeepSeek Harness session without taking any
capability away. Three extension points, all inside the Harness event flow,
plus a panel that puts every saving under your control:

| Extension point | What it does |
|---|---|
| `tools/post-execute` | Compresses each accepted tool result before it is logged: lossless structure-aware transforms first, then a budgeted head/tail elision whose marker names a recovery path. |
| `agent/created` | Hides configured tools from one agent through `ctx.tools.restrict()` on that agent's scoped context, which the loop records as `tool-removal` / `tool-addition` blocks, and opens this conversation's section in the workspace memory document. |
| `agent/inbox/claimed` | Matches a new user message against that document and injects the best excerpts with `agent.inject()`, which appends an `agent/inbox/spliced` event rather than rewriting history. |
| `conversation.composer.dock` | The panel: one switch per saving, applied to the live session and persisted next to the profile. |

**New in 2.0.0** — the saving-mode panel and the workspace memory with recall;
see [`CHANGELOG.md`](./CHANGELOG.md). Version 1.0.0's behaviour and config keys
are unchanged.

Measured on this machine over the four completed recorded sessions (149 model
requests, 8.6 M baseline prompt tokens, dominated by web-fetch, terminal, and
file-read output):

```
prompt tokens        8,624,238 -> 5,022,830   41.76%   target 40% -> MET
tool-result chars      684,300 ->   149,970   78.1%
cache-eligible       8,309,095 -> 4,841,277   41.74%
cache hit rate           96.35% ->     96.39%
```

That is the compression half alone; the memory and recall features add a small
bounded cost (at most `recall.maxChars` per matched message, zero when nothing
matches) in exchange for not re-reading the transcript.

## The saving-mode panel

A pill sits under the composer. It shows how many savings are on and opens a
list of all nine, each with a switch:

```
▾ Token savings                     11/9 savings on   applied to this session immediately; no restart.
  ● Terminal noise    Strip ANSI escapes and carriage-return repaints.        [switch]
  ● Column padding    Collapse alignment padding, keeping indentation.        [switch]
  ● Repeated lines    Fold runs of identical lines into a count.              [switch]
  ● Counting runs     Fold build counters and timestamps into a range.        [switch]
  ● JSON              Minify JSON and tabulate homogeneous arrays.            [switch]
  ● Head/tail trim    Bound oversized results; every cut names a recovery path.
  ● Tool catalogue    Hide tools you do not want offered.      (only if hiddenTools is set)
  ● Session memory    Record your inputs and turn digests into the workspace.
  ● Recall            Match a new message against that memory and inject the hits.
  Saved to C:\Users\you\.dsh\profiles\desktop
```

Turning a switch applies it to the running session at once — no restart, and no
edit to your profile: the choice is written to `dsh-token-frugal.state.json`
beside the profile. `catalogue` is re-applied to agents that already exist, not
only to ones created later. A mode whose prerequisite is missing (`catalogue`
with an empty `hiddenTools`) is shown greyed and explained rather than silently
doing nothing.

How it is wired, because it is the part that needed research:

- The Client half is a lazy module registered through
  `window.__ModuleLoader__.load`, whose id equals the package name, and it
  mounts with `ctx.slots.inject` + `ctx.slots.register` into
  `conversation.composer.dock`.
- The two halves talk over **one exact HTTP route** (`bridge.path`). That is not
  a preference: `host.call` exists only for sandboxed *dynamic packages*, and
  the Client service catalog (`layout`, `locale`, `sessions`, `slots`, `theme`,
  `timer`, `uiWorkspace`, `workspaces`) has no Host-facing call surface, so a
  profile-installed bundle needs a carrier the page can reach. The shipped
  market plugin solves it the same way.
- Visible text follows the locale read from the Client `locale` service, and
  every colour is a `--dsw-alias-*` theme token, so light and dark both read
  correctly with no stylesheet.

## The workspace memory document

One markdown file per workspace, one `## session` section per conversation, one
`### ` block per recorded item:

```md
# dsh-token-frugal session memory

## session-815c4306818a — 2026-10-08 06:11 UTC · C:\work\project

### user · 2026-10-08 06:12 UTC

请记住：重试策略实现在 dispatcher 里，超时参数在 timeoutPolicy。

### summary turn 1 · 2026-10-08 06:20 UTC

- 已完成重试策略迁移
- 已用 29 个测试验证
```

- **Your messages are recorded verbatim**, because a future query resembles a
  past input far more closely than it resembles a summary of one.
- **The digest is extractive, not generated.** It keeps bullets and
  conclusion-shaped lines, never quotes fenced code, and falls back to the
  opening sentence. Recording therefore costs **no model tokens**.
- The path is relative to the session's workspace, so the record travels with
  the work. Add it to `.gitignore` when the workspace is a repository.

## Recall

Every new user message is matched against that document before the model reads
anything. Tokens are Latin words plus **CJK bigrams**, so Chinese matches
without shipping a segmenter; scoring is term frequency weighted by inverse
document frequency across the document's own blocks, with a boost for your own
verbatim wording and length damping so a long block cannot win on sheer size.

Three rules keep it from costing more than it saves:

1. **Cross-conversation notes win.** Blocks from other sessions in the same
   workspace carry information this session has never seen; this session's own
   blocks are only a fallback, for when compaction has pruned them.
2. **Corroboration is required.** At least `recall.minMatchedTerms` distinct
   terms must match, so one shared word cannot spend tokens on an extract that
   has nothing to do with the question.
3. **It is append-only.** The excerpts arrive through `agent.inject()`, which
   lands as an `agent/inbox/spliced` event — an addition to the request, not a
   rewrite of it, so the provider's prefix cache survives. Blocks recorded in
   the current turn are never quoted back, and the same extracts are never
   injected twice in a row.

The injected text names its source and says what to do with it:

```text
<recalled-context source="C:\work\project\.dsh-token-frugal\memory.md">
Matches from this workspace's session memory, recorded from earlier turns and
earlier conversations here. Prefer these over re-reading the transcript or
re-deriving what was already established. They are extracts, not the full record;
read C:\work\project\.dsh-token-frugal\memory.md when you need more.
...
</recalled-context>
```

Measured on this machine over the four completed recorded sessions (149 model
requests, 8.6 M baseline prompt tokens, dominated by web-fetch, terminal, and
file-read output):

```
prompt tokens        8,624,238 -> 5,022,830   41.76%   target 40% -> MET
tool-result chars      684,300 ->   149,970   78.1%
cache-eligible       8,309,095 -> 4,841,277   41.74%
cache hit rate           96.35% ->     96.39%
```

Reproduce it with `node tools/measure-tokens.mjs --compare-placement`. The
session the measurement runs inside is excluded by default, because it is still
being appended to and would make the result depend on when it was taken;
`--include-live` includes it.

## Why this does not duplicate compaction or spill

The Harness already ships two mechanisms that bound tool output, and this plugin
deliberately leaves both of them alone:

- **`dsh-compaction-tool-result-pruner`** rewrites *historical* surface nodes
  once a compaction trigger qualifies. Its own README records the cost:
  "Replacing an earlier result invalidates reuse from the first changed token."
  This plugin never touches the surface — it changes the bytes that are written
  into it in the first place, so history stays append-only and prefix-cacheable.
- **`dsh-spill-policy`** decides that one oversized result should become a
  head/tail preview plus a stored copy and a locator, under one global token
  budget. This plugin does not store anything itself: it calls the shared
  `ctx.spillStore` service when its own elision needs somewhere to put the full
  text, and it skips elision entirely when that service is absent. It also
  recognises an existing spill notice and reuses its locator rather than
  spilling the same result twice.

The two are complementary rather than overlapping because this plugin's listener
registers *after* the shipped spill listener (which prepends itself), so the
pipeline is: **structure-aware compression → this plugin's per-tool elision →
spill policy's token budget**. Spill stays the authority for the final token cap
and for retention; this plugin makes the content cheaper before that decision is
made, and keeps per-tool budgets and error-bearing middle lines that a global
cap cannot express.

## What the model actually sees

Two kinds of change, both announced in the text itself.

**Lossless encoding.** Terminal control sequences and carriage-return repaints
are resolved; alignment padding inside a line is collapsed while indentation is
preserved; trailing whitespace and blank-line runs go; runs of identical lines
become one line plus `... (x40 identical)`; an arithmetic progression such as a
build counter or a timestamp series becomes its two endpoints plus
`... (1 -> 20 step 1; 18 line(s) folded)`, which reconstructs every folded line
exactly; pretty-printed JSON is minified, and a homogeneous array of flat objects
becomes a labelled table (`[30 rows, 3 columns: id, name, ok]` followed by TSV
rows) — a lossless re-encoding, not a summary.

**Budgeted elision**, only when the lossless result still exceeds that tool's
budget:

```
... [357 line(s), 19538 char(s) elided by dsh-token-frugal. Re-read C:\x\big.ts with offset/limit for the elided lines.] ...
```

The head and tail are kept, any middle line matching an error/warning pattern is
kept, and the marker states exactly how much was dropped and how to get it back.
Rich blocks (images, files) are never elided, never reordered, and never moved
relative to text: the budget is split across text blocks rather than
concatenating them.

## Recoverability is a precondition, not a best effort

| Situation | Behaviour |
|---|---|
| The result already carries a spill notice | The elision proceeds and the existing locator stays in the text. |
| A `read` result, `readSourceRecovery: true` | Recoverable by construction — the file on disk is the source of truth, and the marker names the path and says to re-read with `offset`/`limit`. |
| `ctx.spillStore` is available | The full text is saved through that shared service and its locator is put in the marker. |
| No recovery path at all | **Elision is skipped.** Only the lossless transforms run. The plugin never drops text it cannot hand back. |
| A failed call (`isError`) | The budget is multiplied by `errorBudgetFactor` (default 2): an error message is worth more than a success message of the same size. |
| Anything throws inside the transform | The untouched decision is returned and a warning is logged. A compression fault can never turn a successful tool call into an error. |

Setting `recovery: none` disables elision outright — the lossless floor is a
measured **1.87%** prompt-token reduction with zero bytes dropped.

## Configuration

Every tunable lives in the row's `config` in
[`cordis.patch.yml`](./cordis.patch.yml), so the effective policy reads in one
place and survives plugin upgrades. `lib/defaults.js` holds the same values as
plain JSON, and a unit test pins the patch, the field table, and those defaults
to each other.

```yaml
- insert:
    - id: token-frugal
      name: dsh-token-frugal
      config:
        defaultMaxChars: 1500
        toolBudgets: { read: 3000, pwsh: 1200, web_fetch: 4000 }
        skipTools: []
        recovery: spill
        hiddenTools: []
```

The plugin declares no schemastery `Config`. A profile-installed bundle resolves
its imports from the profile's `node_modules`, where the Harness's own packages
do not exist, so importing `@deepseek-ai/schemastery` would make the row fail to
import — which is exactly what happened on the first install attempt. The plugin
therefore validates its own row config against the `FIELD_KINDS` table in
`index.js`: unknown fields and wrong-typed values fail activation with a message
naming the field. The one thing this gives up is a generated schema form in the
Plugin Manager; the fields are documented here instead.

The fields that matter most:

| Field | Meaning |
|---|---|
| `defaultMaxChars`, `toolBudgets` | Character budget per tool. The defaults are the loosest profile measured to clear 40% with margin. |
| `errorBudgetFactor` | Extra budget for failed calls (default `2`). |
| `skipTools` | Tools left byte-for-byte alone, whatever their size. |
| `transforms` | Toggle each lossless transform. `columns: false` if a workflow depends on reading alignment-padded tables verbatim. |
| `minGainRatio` | A rewrite must save at least this fraction or it is discarded, so trivia never churns the request prefix. |
| `structureAware` | Keep middle lines matching error/warning patterns when eliding. |
| `recovery` | `spill` (default) or `none` for lossless-only. |
| `hiddenTools` | Tool names hidden from every agent. Empty by default: hiding a tool removes a capability, so it is opt-in. |

### Measured budget profiles

Same corpus, same methodology; `--budgets` and `--default-max-chars` reproduce
each row:

| Profile | Prompt-token reduction |
|---|---|
| `recovery: none` (lossless only, nothing dropped) | 1.87% |
| Looser (`read: 4000`, `pwsh: 2000`, default `2500`) | 38.74% |
| Mid (`read: 3200`, `pwsh: 1300`, default `1600`) | 41.09% |
| **Shipped defaults** (`read: 3000`, `pwsh: 1200`, default `1500`) | **41.76%** |

Reduction is workload-dependent, so the aggregate is reported with its spread.
Per session in the same corpus: 66.1%, 56.9%, 37.4%, 32.9%. Sessions made
mostly of small tool results have little to elide and gain the least; sessions
dominated by fetched pages, terminal output, and re-read files gain the most.
The shipped defaults sit just above the loosest profile that still clears 40%
(`read: 3200`, `pwsh: 1300`), which is why they are tighter than they look.

### Tool-catalogue visibility

The `agent/created` half is inert until `hiddenTools` names something, because
hiding a tool costs a capability. The measurement quantifies what it would buy
before you decide — on this corpus, of the recorded tool schemas (6,770 tokens
on every request), **14 were never called once**, costing 2,846 tokens per
request, or 4.92% of the whole baseline:

```
workflow(852) subagent_fork(275) update_goal(250) present(199) job_output(158)
create_goal(149) send_message(136) exit_plan_mode(122) ...
```

Uncomment the example block at the end of `cordis.patch.yml` to drop the ones you
accept losing. Hiding is implemented as `ctx.tools.restrict()` on the agent's own
scoped context, so it stays aligned with schema presentation, lookup, and
execution, and unknown names are reported and ignored rather than throwing — an
`agent/created` listener that throws would roll back agent creation.

## Measurement script

```
node tools/measure-tokens.mjs [options] [session-log-or-directory ...]
```

With no path it reads every session log under `$DSH_HOME/sessions`. It rebuilds
each session's surface from its `surfaceOp` records (so replacements, resumes,
and compaction are priced the way the loop assembles a request), replays every
`step/start` twice — as recorded and with the configured policy applied — and
prices both with the same fixed-density heuristic the Harness uses for its
`contextBreakdown` projection.

| Option | Purpose |
|---|---|
| `--json <path>` | Write the complete report; stdout stays a summary. |
| `--max-lines <n>` | Hard stdout line budget (default 100). |
| `--target <percent>` | Target for the verdict (default 40). Exit status 0 when met, 2 when not. |
| `--compare-placement` | Also model delivering the same reduction by rewriting history once, late. |
| `--include-live` | Include the session that is still being written (excluded by default). |
| `--budgets`, `--default-max-chars`, `--no-elide` | Re-price an alternative policy without editing anything. |
| `--only <tool>`, `--patch`, `--no-patch`, `--config`, `--quiet` | Narrowing and policy selection. |

**Bounded by construction.** The script prints at most `--max-lines` lines, each
clamped to 240 characters, and streams one session at a time keeping only
aggregates — so running it from an agent cannot flood that agent's context. On
this corpus the default summary is about 55 short lines (roughly 2 k tokens) and
takes well under half a second. A full run with `--json` produces the complete
report off-machine.

### Reading the cache numbers

The cache figures need one caveat, because they are easy to misread. The
Harness already has near-total prefix reuse (96.35% here, and the provider's own
recorded usage agrees at 96.90%), so there is almost no *hit rate* left to win.
The gain is in **volume**: the same ~96% is now a 96% share of a prompt that is
42% smaller, so both the cached and the uncached halves shrink together.

What the placement does buy is the absence of a cost. `--compare-placement`
models the alternative — delivering the same reduction by rewriting history
once, late — and shows the hit rate collapsing to 56.30% for the request that
lands the rewrite, worth 76,652 prompt tokens of lost reuse once per session.
Changing the bytes at the source pays that zero times, because the prefix was
never sent in its larger form.

## Verification status

| Check | Result |
|---|---|
| `node --test test/*.test.mjs` | 29 tests pass: transform invariants (never grow, idempotent, rich blocks preserved), patch ⇄ field-table ⇄ defaults agreement, config validation, policy decisions, multi-frame log decoding. |
| `node test/load-check.mjs` | Passes: exports, both extension points driven through a fake context, fault isolation, unknown-field rejection, and the refuse-to-elide-without-recovery rule. |
| Live mount | **Verified.** `install_bundle` reports `application: applied` with no warnings; the row is live (`Config.listConfigs` → `patchId: token-frugal`, `status: absent` because the plugin declares no schema). |
| Live elision and recovery | **Verified end to end.** A 400-line `pwsh` result was logged as 15 retained head lines, 11 tail lines, and a marker naming the truncation; the full 400-line original was found at the locator the marker named, written by `dsh-spill-local` through the shared `ctx.spillStore` service. |

The live result, verbatim from a tool call made after installation:

```
line 15 value 416967 payload 17856
... [374 line(s), 13283 char(s) elided by dsh-token-frugal. Full text saved at
<temp>/dsh-spill-*/session-*/…-pwsh.txt: Use read with offset/limit, or grep this path
to search within it.] ...
line 400 value 119087 payload 17513
```

and the artifact it names contained all 400 lines (14,590 bytes), first line
intact and last line intact.

For 2.0.0 the same `load-check` also drives the v2 surface in one process:
the memory document is created, filled with a verbatim message and a turn
digest, and matched on the next message, which injects 643 characters through
`agent.inject`; a repeated match is suppressed; the mode route answers `GET`
with all nine modes, persists a `POST`, reports the change back, rejects an
unknown mode with 400 and an unsupported method with 405; and the Client half is
imported with a fake module loader to assert its module id, its `slots`
dependency, and the exact `conversation.composer.dock` registration.

**A running Harness must be restarted once to load v2.** A profile-installed
bundle is an ES module cached per process, so a disable/enable cycle keeps
executing the previous code generation — `set_bundle` reports
`unknown config field "modes"` from the cached copy until the process restarts.
That is a property of the Harness, not of this plugin.

```bash
npm run verify                                  # syntax, unit tests, load check
node tools/measure-tokens.mjs --compare-placement --json report.json
```

`load-check` resolves `@deepseek-ai/schemastery` the way the Harness does. Inside
a Harness process that is just the bare specifier; from a plain shell it reads
the two packages it needs straight out of the installed `app.asar`, which it
locates automatically. Point it elsewhere with `--from-asar <path>` or
`--core-dir <dir>`, or set `DSH_APP_ASAR`.

## Known limitations

- **Character budgets approximate tokens.** They are code points, not
  tokenizer output; the Harness's own `ctx.tokenMeter` remains the authority for
  whether pressure was relieved.
- **Trimming is syntactic.** Middle-line selection keeps the head, the tail, and
  anything matching an error/warning pattern. It does not interpret which middle
  lines matter semantically — that would need a model call, which this plugin
  deliberately never makes.
- **`columns: true` is a judgement call.** Collapsing runs of ≥3 spaces inside a
  line removes table padding, which is most of a PowerShell `Format-Table`, and
  also removes intra-line alignment inside string literals. `read`, `grep`, and
  similar source-text tools get a tighter budget for the same reason; turn
  `columns` off, or add a tool to `skipTools`, if a workflow depends on exact
  spacing.
- **The catalogue lever is evidence, not certainty.** "Never called in these
  logs" is not "never needed" — `exit_plan_mode`, for instance, is only used in
  plan mode. Read the list before uncommenting it.
- **A resume reads the compressed log.** Because compression happens before the
  `tool/result` event is appended, a resumed or forked session sees the
  compressed text, not the original. Recovery is through the spill locator or,
  for `read`, the file itself.
- **`dsh-spill-policy` takes precedence on ordering.** The pipeline described
  above assumes the shipped spill listener keeps prepending itself. If another
  plugin replaces that ordering, this plugin's elision runs after spill's
  bounding instead — still correct, since an existing notice is detected and
  respected, but the recovery locator in the marker is then spill's.

## Appendix: the original v2 request, verbatim

This is the request 2.0.0 was built from, reproduced unchanged (it was committed
to this file through GitHub's web editor while the version was being scoped).
Its names and commands were the *request*, not the shipped interface, so they are
mapped to the real ones underneath rather than published as instructions.

````text
dsh-your-plugin

一个用于减少 DSH 调用 token 浪费的插件。

功能

· 在工具输出写入对话前进行头尾裁剪，中间用元数据替换
· 对 JSON/CSV 等结构化输出做压缩，降低上下文占用
· 管理工具 schema 可见性，避免不用的工具描述进入请求
· 附带测量脚本，报告优化前后的 token 对比

安装

```bash
dsh plugin --profile web add dsh-your-plugin
```

配置

在 cordis.patch.yml 中调整参数：

```yaml
config:
  thresholdRatio: 0.3
  keepHeadRatio: 0.4
  keepTailRatio: 0.4
  exemptTools: []
```

开发

```bash
git clone https://github.com/<你的账号>/dsh-your-plugin.git
cd dsh-your-plugin
npm install
```

插件导出 { name, inject, apply }，所有改写走 DSH 事件流，保持 model-visible 与 logged 一致。

验证

```bash
node measure-token-savings.mjs
```

输出优化前后的 token 数对比与缓存命中率变化。

（后续会创建自选优化项目的窗口，以供个人自己调配）
（这次忘记添加在工作文件夹后自动创建md脚本，以防止反复调去上下文消耗大量token）
````

| In the request | Shipped |
|---|---|
| `dsh-your-plugin` | `dsh-token-frugal` |
| `dsh plugin --profile web add dsh-your-plugin` | No such CLI exists; a bundle is installed with the Harness plugin manager's `install_bundle` action against the package directory (see "Install" in the release notes). |
| `thresholdRatio`, `keepHeadRatio`, `keepTailRatio`, `exemptTools` | `defaultMaxChars` + per-tool `toolBudgets`, `headRatio`, `tailRatio`, `skipTools`, `hiddenTools` |
| `measure-token-savings.mjs` | `tools/measure-tokens.mjs` |
| （后续会创建自选优化项目的窗口） | Delivered: the saving-mode panel in `conversation.composer.dock`, one switch per saving. |
| （这次忘记添加在工作文件夹后自动创建 md 脚本） | Delivered: the per-workspace memory document plus recall, which is what stops context being re-read. |
