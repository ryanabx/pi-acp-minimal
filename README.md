# pi-acp-minimal

An [Agent Client Protocol](https://agentclientprotocol.com) (ACP) adapter for
[`pi`](https://pi.dev), so pi can be driven from any ACP client — Zed, Neovim,
Emacs, and friends.

The adapter is a thin translation layer. It speaks ACP over stdio to the editor
and pi's [RPC protocol](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/rpc.md)
over stdin/stdout to a `pi --mode rpc` child process, and its job is almost
entirely a mapping from one set of types to the other.

```
editor  ──ACP (JSON-RPC/stdio)──▶  pi-acp-minimal  ──pi RPC (JSONL/stdio)──▶  pi --mode rpc
```

## Run it

No checkout or build needed — `npx` installs straight from the repository:

```bash
npx github:ryanabx/pi-acp-minimal --help
```

`pi` must be on your `PATH` (or point at it with `--pi-command`).

This is not published to the npm registry. Installing from git means npm clones
the repo, installs the build toolchain, compiles it, and caches the result.

### From a checkout

```bash
npm ci --ignore-scripts   # nothing in the runtime tree needs an install script
npm run build             # emits dist/, with dist/cli.js as the entry point
```

## Use it from an ACP client

Zed (`settings.json`):

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "github:ryanabx/pi-acp-minimal#v1.0.0"]
    }
  }
}
```

**Pin to a tag or commit.** The client launches this on every session, so an
unpinned `github:ryanabx/pi-acp-minimal` silently follows whatever `main` points
at — including any commit pushed since you last looked.

Running from a local checkout instead:

```json
{
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/absolute/path/to/pi-acp-minimal/dist/cli.js"]
    }
  }
}
```

Zed caches an agent's config options, so reload it (or restart Zed) after
changing what the adapter advertises, or you will be looking at a stale
model list.

### CLI options

| Option | Effect |
|---|---|
| `--pi-command <path>` | Executable used to launch pi (default: `$PI_ACP_PI_COMMAND`, else `pi`) |
| `--model <pattern>` | Forwarded to pi as `--model` |
| `--provider <name>` | Forwarded to pi as `--provider` |
| `--session-dir <path>` | Forwarded to pi as `--session-dir` |
| `--approve` | Forwarded to pi as `--approve` (trust project-local extensions/skills) |
| `--log-file <path>` | Append every ACP frame, both directions, to a JSONL file |
| `--quiet` | Do not mirror pi's stderr |
| `-- <args...>` | Everything after `--` is forwarded verbatim to every pi process |

`--log-file` captures full ACP frames, which include prompt text and any file
contents that flow through tool calls. Use it for debugging, not routinely.

## Architecture

One ACP session owns one `pi --mode rpc` child process, spawned with the
session's `cwd`. That is what makes pi's per-project settings, extensions,
skills and prompt templates load correctly for each session.

```
src/
  cli.ts              entry point: stdio -> AgentSideConnection -> PiAcpAgent
  acp/
    agent.ts          ACP `Agent`: initialize, session/{new,load,prompt,cancel,set_mode,set_model}
    session.ts        one pi process + the RPC-event -> session/update mapping
    file-access.ts    reads files via the client's fs when available, else local disk
    errors.ts         JSON-RPC errors that carry a readable message
  pi/
    rpc-types.ts      structural mirror of pi's RPC protocol
    rpc-client.ts     spawn pi, JSONL framing, request/response correlation
    jsonl.ts          LF-only framing (pi's protocol forbids splitting on U+2028/9)
  map/
    content.ts        ACP ContentBlock <-> pi message content
    tools.ts          pi tool name/args -> ACP kind, title, locations
    models.ts         pi Model <-> ACP ModelInfo
    modes.ts          pi thinking level <-> ACP session mode
    commands.ts       pi slash command -> ACP AvailableCommand
```

All pi stdout traffic is funnelled through a serial queue in `PiSession`, so
`session/update` notifications reach the client in the order pi produced them
even where a mapping step has to await the file system.

## What maps to what

### ACP requests → pi RPC commands

| ACP | pi RPC |
|---|---|
| `initialize` | — (capability negotiation only) |
| `session/new` | spawn `pi --mode rpc` in `cwd`, then `get_state` + `get_available_models` + `get_available_thinking_levels` + `get_commands` |
| `session/load` | spawn `pi --mode rpc --session <file>`, then `get_messages` replayed as updates |
| `session/prompt` | `prompt` |
| `session/cancel` | `abort` |
| `session/set_config_option` | `set_model` or `set_thinking_level` |
| `authenticate` | — (pi owns its credentials; see below) |

### pi RPC events → ACP `session/update`

| pi event | ACP update |
|---|---|
| `message_update` / `text_delta` | `agent_message_chunk` |
| `message_update` / `thinking_delta` | `agent_thought_chunk` |
| `message_update` / `toolcall_start` | `tool_call` (status `pending`) |
| `message_update` / `toolcall_end` | `tool_call_update` with `rawInput`, title, kind, locations |
| `tool_execution_start` | `tool_call_update` (status `in_progress`) |
| `tool_execution_update` | `tool_call_update` with the accumulated output |
| `tool_execution_end` | `tool_call_update` (status `completed`/`failed`), diff or text content, `rawOutput` |
| `agent_settled` | resolves `session/prompt` |
| `compaction_*`, `auto_retry_*`, `summarization_retry_*`, `extension_error` | italic `agent_message_chunk` status lines |
| `get_commands` (polled after each turn) | `available_commands_update` |
| `get_session_stats` (polled per turn) | `usage_update` |

Stop reasons: pi's `stop`/`toolUse` → `end_turn`, `length` → `max_tokens`,
`aborted` (or a client cancel) → `cancelled`. A turn that ends in pi's `error`
state is reported as a JSON-RPC error on `session/prompt`, carrying pi's message.

### Tool calls

`edit`/`write`/`read`/`ls`/`grep`/`find`/`bash`/`powershell` get ACP tool
kinds, human-readable titles (`Edit src/a.ts (2 edits)`, `Search "TODO" in *.ts`,
the command line itself for `bash`) and `locations` so clients can follow along
in the editor. Extension tools fall back to name-based heuristics.

For `edit` and `write` the adapter snapshots the file at `tool_execution_start`
and re-reads it at `tool_execution_end`, emitting a real ACP `diff` content
block rather than a blob of text. When the client advertises
`fs.readTextFile`, the snapshot comes from the client so unsaved editor buffers
are respected.

### Session config options

ACP exposes a session's adjustable settings as a `configOptions` list on
`session/new`, changed via `session/set_config_option`. pi has exactly two such
knobs, and they line up with ACP's own categories:

| pi | ACP config option | category |
|---|---|---|
| model | `model` | `model` |
| thinking level | `thinking` | `thought_level` |

Models are grouped by provider once more than one provider is configured.

The thinking option is shown only when `get_available_thinking_levels` reports
two or more levels, and then offers exactly those. Anything less is pi saying
there is no choice to make — whether that is a lone `["off"]`, a model pinned to
a single level, or a query that returned nothing — so no control is shown. The
adapter never invents levels pi did not report.

pi's `set_thinking_level` **clamps** the requested level to what the model
supports and returns success either way, so the response cannot be taken at face
value. The adapter re-reads the level from pi afterwards and reports the clamped
result, logging the clamp to stderr.

Any model with `reasoning: false` — which includes every llama.cpp model by
default — reports only `off`, so it gets no thinking control. To enable one, tell
pi the model supports reasoning with a `modelOverrides` entry (`reasoning: true`,
plus `thinkingLevelMap` if only some levels apply); see pi's `docs/models.md`.

`session/set_config_option` returns the full refreshed list, which is how the
client learns that switching models changed the available thinking levels.

The list is also re-read after every turn and pushed as `config_option_update`
when it changes, because pi's view of a model is not static: `/llama` and
similar extension commands can add or remove models, and llama.cpp only reports
a model's real fitted context window once that model has been loaded.

### Context usage

`get_session_stats` becomes ACP `usage_update`:

| pi | ACP |
|---|---|
| `contextUsage.tokens` | `used` |
| `contextUsage.contextWindow` | `size` |
| `cost` | `cost.amount` (USD) |

ACP reports context *occupancy*, so this uses pi's `contextUsage` rather than
its cumulative token totals — the latter counts every token the session ever
spent, including history compaction has since dropped.

Usage is published when the session starts, after each turn within an agent run,
and once more when the prompt settles; identical figures are not re-sent. pi
reports no figure when there is no model or context window, and nulls it out
between a compaction and the next assistant response, so updates simply pause
rather than reporting something wrong.

### Slash commands

pi's extension commands, prompt templates and skills are published as ACP
`available_commands_update` on session start and after every turn (extensions
can register commands at runtime). ACP clients send the chosen command back as
plain `/name args` text, which is exactly what pi's `prompt` already expands.

### Permission requests

pi has no built-in permission system — it runs with the privileges of the user
who launched it. What it does have is an extension UI protocol, which is how
approval-style extensions ask questions. Those are bridged to ACP:

| pi extension UI | ACP |
|---|---|
| `confirm` | `session/request_permission` with Yes / No options |
| `select` | `session/request_permission`, one option each (kind inferred from the label) |
| `notify` | italic `agent_message_chunk` |
| `input`, `editor` | declined (ACP has no free-text prompt), reported to the user |
| `setStatus`, `setWidget`, `setTitle`, `set_editor_text` | ignored (TUI chrome) |

When a tool is running, the dialog attaches to that tool call; otherwise it gets
a synthetic one so it still appears in the transcript.

## Known limitations

- **MCP servers** supplied by the client in `session/new` are ignored, with a
  warning on stderr. pi loads MCP servers from its own settings.
- **Terminals.** pi runs shell commands itself, so `terminal/*` is not used;
  `bash` output is streamed as tool call content instead.
- **Plans.** pi has no todo/plan tool, so no `plan` updates are emitted.
- **Audio** content in prompts is not supported.
- **Authentication.** pi manages provider credentials (`pi auth login`), so no
  ACP auth methods are advertised and `authenticate` returns a pointer to that
  command.
- **`session/load` requires session persistence.** Sessions started with
  `--no-session` get a non-reloadable id.
- **Session modes** (`session/set_mode`) are not used. pi has no operating
  modes, and its thinking level is a better fit for the `thought_level` config
  option category.
- **Prompts that only run an extension command** never start a pi agent run and
  so never emit `agent_settled`. The adapter polls `get_state` and ends the turn
  once pi has been idle for ~1.5s.
- **Model metadata is only as good as pi's.** Context windows in particular come
  straight from the provider: llama.cpp reports none for an unloaded model, and
  pi substitutes a 128k default until the model is loaded. The adapter re-reads
  the options after each turn so the figure corrects itself once that happens.
- **Replayed `edit`/`write` calls show text, not diffs.** A live turn emits a
  real diff because the adapter snapshots the file before the tool runs. pi's
  session history stores only the tool's text result, so `session/load` replays
  that instead.

## Supply chain

npm's threat model is that any package in the tree can run code during install
and ship code into the process. This adapter keeps that surface small enough to
read in one sitting, and enforces it in CI.

**The entire runtime tree is two packages:**

```
pi-acp-minimal
└─┬ @agentclientprotocol/sdk@1.4.0   (the ACP protocol implementation)
  └── zod@4.5.4                      (its schema validator, a peer dependency)
```

Neither declares an install lifecycle script, and both carry verified npm
registry signatures and build attestations (`npm run audit`).

The policy:

- **Direct dependencies are pinned to exact versions.** `.npmrc` sets
  `save-exact=true`, and `check:deps` fails on any range specifier.
- **`min-release-age=2`** keeps resolution off dependency releases younger than
  two days, so a compromised publish has time to be caught before it lands here.
- **The runtime closure is allowlisted** in
  [`scripts/allowed-runtime-packages.mjs`](scripts/allowed-runtime-packages.mjs).
  A new transitive package fails the build until someone adds it deliberately.
- **No install scripts at runtime.** `check:deps` rejects any runtime package
  declaring `preinstall`, `install`, `postinstall` or `prepare`.
- **`npm-shrinkwrap.json` is the committed lockfile**, not `package-lock.json`.
  npm honours a shrinkwrap when this package is installed as a dependency, so
  installing from git resolves the exact same versions and integrity hashes
  recorded here. Without it, the SDK's `zod` peer range (`^3.25.0 || ^4.0.0`)
  would resolve to whatever is newest at install time.
- **CI installs with `npm ci --ignore-scripts`** and fails on any advisory
  affecting runtime dependencies. Dev-only advisories are reported without
  failing the build, since they cannot reach the runtime tree.

### What installing from git actually costs

`npx github:...` builds from source, because `dist/` is not committed. npm
therefore installs the **full devDependency tree** into a temporary directory to
run `tsc`, and those packages' install scripts do run — esbuild, pulled in via
vitest, has a `postinstall`.

The versions are all pinned by `npm-shrinkwrap.json`, and none of it survives
into the installed package: what remains is the three-package tree above, with
no install scripts. But if you want zero third-party install-time code
execution, run from a checkout you have already built, and point your client at
`dist/cli.js` directly.

Audit it yourself:

```bash
npm run check:deps      # pins, allowlist, no runtime install hooks
npm run check:package   # what a consumer actually installs
npm run audit           # advisories + registry signatures for runtime deps
npm ls --omit=dev --all # the whole runtime tree
```

## Development

```bash
npm run check         # typecheck + dependency policy
npm test              # unit + end-to-end tests against a mock pi
npm run build         # emit dist/
npm run check:package # verify the published tarball
```

`test/mock-pi.mjs` is a scripted stand-in for `pi --mode rpc`. Scenarios are
selected by a marker in the prompt text (`TEXT`, `EDIT`, `BASH`, `CONFIRM`,
`SLOW`, `RETRY`, …), which keeps the end-to-end tests deterministic and free of
any provider dependency.

To also run smoke tests against a real pi install (handshake, session setup and
a live cancel — no model provider needed):

```bash
PI_ACP_REAL_PI=1 npm test
```

For a full manual check against a real model, `scripts/live-check.mts` drives a
tool-using turn, a follow-up turn, a mid-flight cancel, a model switch and a
`session/load` replay, logging every `session/update` in wire order:

```bash
LIVE_MODEL=<provider>/<model> npx tsx scripts/live-check.mts
```

It is a script rather than a test because real model output is not deterministic
enough to assert on.

### A note on the ACP TypeScript SDK

This uses `@agentclientprotocol/sdk`, the current official TypeScript SDK.

Beware of `@zed-industries/agent-client-protocol`: it is the *old* package name,
its newest release (0.4.5) is far behind the protocol Zed actually speaks, and
it still models model selection as `NewSessionResponse.models` plus
`session/set_model` — both of which have since been replaced by config options.
Building against it produces an agent whose model picker silently never appears.

The test harness speaks JSON-RPC directly rather than through
`ClientSideConnection`, so tests assert the exact wire methods the adapter
serves.
