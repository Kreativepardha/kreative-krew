# Architecture

One mod, two roles. Every session loads the same module; the session whose id is in the shared store under `krew:lead` is the **Manager**. Membership is opt-in (`isMember` in `hooks/core/util.ts`): a session is a **worker** when it adopted a hire tag or carries `KREW_NAME`, or when its cwd, project root or git common dir lies under the Manager's `root`. Any other session is inert: no card, heartbeat, prompt section, notes or Witness writes.

```
            ┌──────────── MANAGER (Edit/Write/NotebookEdit denied) ─────────────┐
            │  poll every 5s: cards → inbox → announce → swaps → quality →      │
            │  refinery; radar every 3 min; gh pr view every 2 min; digests     │
            └───────▲───────────────────────────────────────────────▲───────────┘
   $.session.send / session.receive                          $.store (shared, atomic)
   [krew:ctl] {op, token}                                     krew:card:<sid>  krew:log:<sid>
            │                                                 krew:notes:<sid> krew:leadstate
   ┌────────┴────────┐  ┌─────────────────┐                   krew:handoff:<id> krew:retired:<sid>
   │ WORKER Atlas    │  │ WORKER Nova     │   subagent types (registered by the mod):
   │ worktree, ports │  │ worktree, ports │   kreative-krew:reviewer · test-writer · goal-checker
   └─────────────────┘  └─────────────────┘
```

## Store layout (single writer per key)

| Key | Writer | Content |
|---|---|---|
| `krew:lead` | `/krew-lead` | `{ sid, token, since, root }`; the token authenticates control messages, `root` decides membership |
| `krew:card:<sid>` | that worker | its `Card` (state, task, bullets, needs, repos, PRs, signals, sharpness…) |
| `krew:log:<sid>` | that session | ring of `KEvent` (edit, test, fail, commit, pr, verify, witness, compact, swap…) |
| `krew:notes:<sid>` | that session | ring of team notes |
| `krew:leadstate` | Manager | briefs, swaps, merge queue, groups, mode, dismissed, drills, merged |
| `krew:handoff:<swap>` | worker, then Manager | raw handoff, then the audited `HandoffPacket` |

`$.fs.write` is not atomic and 4 MiB-capped, so nothing shared goes through files.

## Messages between sessions

- **Control**: `[krew:ctl] {"op":"freeze"|"retire"|"compact"|"canary"|"judge"|"heads-up"|"warm-ack", "token":…}`. A worker's `session.receive` hook consumes them (never shown to the model) after checking the token against `krew:lead`. `freeze` and `retire` are turned into a plain-text brief the model does read.
- **Hire tags**: a prompt or message starting with `[krew:hire name="Atlas II" gen=2 brief=b7 worktree=… ports=4100 handoff=s3 pred=<sid> …]` sets the worker's identity. Hired sessions receive it as their first prompt (`claude --bg -n Name "<tag>\n<brief>"`); existing workers receive it as a peer message before a new brief.
- **Human replies** go as `[Kreative Krew] The human replies to "…": …`.

## Hook map

| Event | Worker | Manager |
|---|---|---|
| `session.start` | card, tools, agent types, commands, timers | same + opens the pane when it is already the lead |
| `prompt.submit` | adopts hire tags, counts corrections, attaches new team notes | — |
| `prompt.compose` | session-scoped “you are X on a crew” section | “you are the MANAGER; delegate with krew_brief” |
| `turn.start / complete` | state, stall ledger, boundary detection, Haiku card summary | — |
| `tool.call` (observe) | Witness signals, repo touches, rule breaks, collision heads-up, PR detection → verification triad | denies Edit/Write/NotebookEdit |
| `session.measure` | context %, cost, budget needs | — |
| `session.compact` | marks compaction for redo detection | — |
| `session.receive` | control ops | — |
| `ui.render` | worker band, hint tail | Pane (5 tabs), band, hint pills, spinner word, tool cards |

## Succession state machine

`proposed → freezing → auditing → spawning → warming → retiring → done` (or `failed` / `rejected`). Planned rotations start themselves; emergency ones wait in the inbox for the human. Timeouts: 10 min for the handoff, 25 min for warm-up, 10 min for retirement, each falling forward rather than hanging.

## Demo mode

`/krew-demo` writes cards with `demo-` session ids. `sendCtl`, `sendText`, teardown, radar, PR checks and the refinery all skip them, and swaps of demo workers are simulated so the whole succession flow can be watched.
