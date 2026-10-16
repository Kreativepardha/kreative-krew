// The Manager's dashboard: Inbox · Team · Radar · Money · Replay.

import { atom, update } from 'claude-code'
import type { EngineInterface, Elements, RenderElement } from 'claude-code'

import type { Board, Card, Need, Tab, UiView } from '../../types'
import { emptyBoard, initialView } from '../core/atoms'
import { renderBrief } from '../core/brief'
import { ago, bar, short, sparkline, usd } from '../core/util'
import {
  approveBrief,
  dismiss,
  draftFor,
  enqueueMerge,
  proposeSwap,
  rejectBrief,
  rejectSwap,
  reply,
  retire,
  reviseBrief,
  sendCtl,
  startSwap,
} from '../lead'

const boardAtom = atom({ plugin: 'kreative-krew', key: 'board' } as const, emptyBoard())
const viewAtom = atom({ plugin: 'kreative-krew', key: 'view' } as const, initialView())

type $T = EngineInterface
export type Els = Partial<Elements['terminal']> & Elements['mobile']

const TABS: { id: Tab; label: string; hotkey: string }[] = [
  { id: 'inbox', label: 'Inbox', hotkey: 'i' },
  { id: 'team', label: 'Team', hotkey: 't' },
  { id: 'radar', label: 'Radar', hotkey: 'r' },
  { id: 'money', label: 'Money', hotkey: 'm' },
  { id: 'replay', label: 'Replay', hotkey: 'p' },
]

const GLYPH: Record<string, string> = { busy: '●', waiting: '◆', idle: '○', frozen: '❄', retiring: '↘' }
const STATE_COLOR: Record<string, string> = { busy: 'success', waiting: 'warning', idle: 'subtle', frozen: 'suggestion', retiring: 'subtle' }
const KIND_ICON: Record<string, string> = {
  brief: '✎',
  swap: '⟳',
  rot: '⟳',
  stuck: '⚠',
  blocked: '⛔',
  budget: '$',
  conflict: '⚡',
  permission: '🔒',
  question: '?',
  approach: '⑂',
  pr: '⇡',
  drill: '🚨',
}

function riskColor(r: number): string {
  return r >= 3 ? 'error' : r === 2 ? 'warning' : 'subtle'
}

function sharpColor(s: number): string {
  return s >= 70 ? 'success' : s >= 40 ? 'warning' : 'error'
}

async function setView($: $T, patch: Partial<UiView>): Promise<void> {
  await update($, viewAtom, v => ({ ...v, ...patch }))
}

function header(E: Els, $: $T, board: Board, view: UiView, now: number): RenderElement {
  const { Box, Text, Button } = E
  const n = (s: string) => board.agents.filter(a => a.state === s).length
  const spend = board.agents.reduce((s, a) => s + a.costUsd, 0)
  const burn = Object.values(board.burn).reduce((s, b) => s + b, 0)
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text bold color="claude">
          KREATIVE KREW <Text dimColor>· {board.lead.mode} mode</Text>
        </Text>
        <Text dimColor>
          <Text color="success">●{n('busy')}</Text> <Text color="warning">◆{n('waiting')}</Text> ○{n('idle')}
          {board.offline.length ? ` · ${board.offline.length} offline` : ''} · {usd(spend)} · {usd(burn)}/h · {ago(now, board.updatedAt)}
        </Text>
      </Box>
      <Box gap={1}>
        {TABS.map(t => (
          <Button
            key={`tab-${t.id}`}
            label={`${t.label}${t.id === 'inbox' && board.inbox.length ? ` ${board.inbox.length}` : ''}`}
            hotkey={t.hotkey}
            variant={view.tab === t.id ? 'primary' : 'secondary'}
            onPress={() => void setView($, { tab: t.id })}
          />
        ))}
        <Button key="detail" label={view.detail ? 'Compact' : 'Detail'} hotkey="d" plain onPress={() => void setView($, { detail: !view.detail })} />
      </Box>
    </Box>
  )
}

function briefRow(E: Els, $: $T, board: Board, need: Need, view: UiView, top: boolean, width: number): RenderElement {
  const { Box, Text, Button, Input, Markdown } = E
  const b = board.lead.briefs.find(x => x.id === need.ref)
  if (!b) return <Text key={need.id}>{need.text}</Text>
  return (
    <Box key={need.id} flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
      <Text bold>
        {KIND_ICON.brief} Brief for approval: {b.title} <Text dimColor>→ {b.assignees.join(', ') || `new hire ${b.hireName}`} · ~{usd(b.budgetUsd)}</Text>
      </Text>
      {b.status === 'compiling' ? (
        <Text dimColor>compiling with the smart model…</Text>
      ) : view.detail && Markdown ? (
        <Markdown text={renderBrief(b)} />
      ) : (
        <Box flexDirection="column">
          <Text wrap="truncate-end">Goal: {short(b.goal, width * 2)}</Text>
          <Text dimColor wrap="truncate-end">
            {b.criteria.length} criteria · owns {short(b.area.join(', ') || '—', 40)} · verify: {short(b.verify[0] ?? '—', 50)}
          </Text>
        </Box>
      )}
      {b.status === 'pending' && (
        <Box gap={1}>
          <Button key={`ap-${b.id}`} label="Approve & send" hotkey={top ? 'a' : undefined} variant="primary" onPress={() => void approveBrief($, b.id).then(t => $.ui.toast(t))} />
          <Button key={`rv-${b.id}`} label="Revise" hotkey={top ? 'v' : undefined} onPress={() => void setView($, { reviseId: view.reviseId === b.id ? undefined : b.id })} />
          <Button key={`rj-${b.id}`} label="Reject" hotkey={top ? 'x' : undefined} onPress={() => void rejectBrief($, b.id)} />
          {!view.detail && <Button key={`full-${b.id}`} label="Full brief" plain onPress={() => void setView($, { detail: true })} />}
        </Box>
      )}
      {view.reviseId === b.id && Input && (
        <Input key={`revise-${b.id}`} label="Revise:" placeholder="e.g. smaller scope, no DB changes" autoFocus onSubmit={value => void reviseBrief($, b.id, value).then(() => setView($, { reviseId: undefined }))} />
      )}
    </Box>
  )
}

function needRow(E: Els, $: $T, board: Board, need: Need, view: UiView, i: number, top: boolean, width: number, now: number): RenderElement {
  const { Box, Text, Button, Input } = E
  if (need.kind === 'brief') return briefRow(E, $, board, need, view, top, width)
  const draft = need.draft ?? draftFor(need.id)
  const card = board.agents.find(a => a.sid === need.sid)
  const pr = card?.prs.find(p => p.url === need.url)
  const swap = need.kind === 'swap' ? board.lead.swaps.find(s => s.id === need.ref) : undefined
  return (
    <Box key={need.id} flexDirection="column" marginBottom={view.detail ? 1 : 0}>
      <Text wrap="truncate-end">
        <Text color={riskColor(need.risk)}>{i + 1}. {KIND_ICON[need.kind] ?? '•'} </Text>
        <Text bold>{need.name ?? 'crew'}</Text> {short(need.text, Math.max(30, width - 18))}
        <Text dimColor> {ago(now, need.at)}</Text>
      </Text>
      {pr?.evidence && (
        <Text dimColor wrap="truncate-end">
          {'   '}evidence: review {mark(pr.evidence.reviewer)} · tests {mark(pr.evidence.tests)} · goal {mark(pr.evidence.goal)} · CI {pr.ci ?? '?'}
        </Text>
      )}
      {need.options && need.options.length > 0 && <Text dimColor>{'   '}options: {need.options.join(' | ')}</Text>}
      {draft && <Text color="suggestion" wrap="truncate-end">{'   '}draft: “{short(draft, width - 14)}”</Text>}
      <Box gap={1} marginLeft={3}>
        {draft && need.sid && <Button key={`sd-${need.id}`} label="Send draft" hotkey={top ? 's' : undefined} variant="primary" onPress={() => void reply($, need, draft)} />}
        {need.sid && need.kind !== 'swap' && Input && <Button key={`rp-${need.id}`} label="Reply" hotkey={top ? 'y' : undefined} onPress={() => void setView($, { replyTo: view.replyTo === need.id ? undefined : need.id })} />}
        {need.kind === 'pr' && need.url && <Button key={`mg-${need.id}`} label="Queue merge" hotkey={top ? 'g' : undefined} onPress={() => void enqueueMerge($, need.url ?? '', need.name ?? '').then(() => dismiss($, need))} />}
        {need.url && <Button key={`cp-${need.id}`} label="Copy link" plain onPress={e => void $.ui.copy({ text: need.url ?? '', surface: e.surface })} />}
        {swap && swap.status === 'proposed' && <Button key={`sw-${need.id}`} label={`Swap → ${swap.toName}`} hotkey={top ? 'w' : undefined} variant="primary" onPress={() => void startSwap($, swap.id)} />}
        {swap && swap.status === 'proposed' && <Button key={`cmp-${need.id}`} label="Compact instead" onPress={() => void sendCtl($, swap.fromSid, { op: 'compact' }).then(() => rejectSwap($, swap.id))} />}
        {swap && swap.status === 'proposed' && <Button key={`ig-${need.id}`} label="Ignore" onPress={() => void rejectSwap($, swap.id)} />}
        {need.sid && <Button key={`at-${need.id}`} label="Attach cmd" plain onPress={e => void $.ui.copy({ text: `claude attach ${need.sid}`, surface: e.surface }).then(() => $.ui.toast('Copied: claude attach …'))} />}
        <Button key={`dn-${need.id}`} label="Done" hotkey={i === 0 ? 'o' : undefined} onPress={() => void dismiss($, need)} />
      </Box>
      {view.replyTo === need.id && Input && (
        <Input key={`in-${need.id}`} label={`→ ${need.name}:`} placeholder="your answer" value={draft} autoFocus onSubmit={value => void reply($, need, value).then(() => setView($, { replyTo: undefined }))} />
      )}
    </Box>
  )
}

function mark(line: string | undefined): string {
  if (!line) return '…'
  return line.startsWith('PASS') ? '✓' : line.startsWith('FAIL') ? '✗' : '?'
}

function inboxTab(E: Els, $: $T, board: Board, view: UiView, width: number, now: number): RenderElement {
  const { Box, Text, Button } = E
  const high = board.inbox.filter(n => n.risk >= 2 || n.kind === 'brief' || n.kind === 'swap' || n.kind === 'drill' || n.kind === 'stuck')
  const low = board.inbox.filter(n => !high.includes(n))
  const batchable = low.filter(n => (n.draft ?? draftFor(n.id)) && n.sid)
  const firstOf = new Map<string, string>()
  for (const n of board.inbox) {
    const group = n.kind === 'question' || n.kind === 'approach' ? 'ask' : n.kind
    if (!firstOf.has(group)) firstOf.set(group, n.id)
  }
  const isTop = (n: Need) => firstOf.get(n.kind === 'question' || n.kind === 'approach' ? 'ask' : n.kind) === n.id
  return (
    <Box flexDirection="column">
      <Text bold>NEEDS YOU <Text dimColor>· risk first · {board.inbox.length} open</Text></Text>
      {board.inbox.length === 0 && <Text dimColor>Nothing needs you. The crew is working. ☕</Text>}
      {high.map((n, i) => needRow(E, $, board, n, view, i, isTop(n), width, now))}
      {low.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box gap={1}>
            <Text bold dimColor>BATCHED · {low.length} low-risk</Text>
            {batchable.length > 0 && (
              <Button key="approve-all" label={`Send ${batchable.length} drafts`} plain onPress={() => void Promise.all(batchable.map(n => reply($, n, n.draft ?? draftFor(n.id) ?? '')))} />
            )}
          </Box>
          {low.map((n, i) => needRow(E, $, board, n, view, high.length + i, isTop(n), width, now))}
        </Box>
      )}
      {board.notes.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold dimColor>TEAM NOTES</Text>
          {board.notes.slice(-4).map((n, i) => (
            <Text key={`note-${n.at}-${i}`} dimColor wrap="truncate-end">
              {n.name}: {short(n.text, width - 12)}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function agentRow(E: Els, $: $T, a: Card, board: Board, view: UiView, now: number, width: number): RenderElement {
  const { Box, Text, Button } = E
  const repo = a.repos[0]
  const burn = board.burn[a.sid] ?? 0
  const nameCol = 12
  return (
    <Box key={`ag-${a.sid}`} flexDirection="column" marginBottom={view.detail ? 1 : 0}>
      <Text wrap="truncate-end">
        <Text color={STATE_COLOR[a.state] ?? 'text'}>{GLYPH[a.state] ?? '•'} </Text>
        <Text bold>{a.name.padEnd(nameCol).slice(0, nameCol)}</Text>
        <Text color={sharpColor(a.sharpness)}>{bar(a.sharpness, 5)}</Text>
        <Text dimColor> ctx {String(a.contextPercent).padStart(2)}% {usd(a.costUsd)} </Text>
        {short(a.task || '—', Math.max(16, width - nameCol - 34))}
        <Text dimColor> {ago(now, a.lastActivityAt)}</Text>
      </Text>
      {view.detail && (
        <Box flexDirection="column" marginLeft={2}>
          {a.bullets.map((b, i) => (
            <Text key={`b-${a.sid}-${i}`} dimColor wrap="truncate-end">
              · {b}
            </Text>
          ))}
          <Text dimColor wrap="truncate-end">
            {repo ? `${repo.repo}@${repo.branch}` : 'no repo yet'} · mood {a.mood} · sharp {a.sharpness}
            {a.gen > 1 ? ` · gen ${a.gen} (${a.lineage.join(' → ')})` : ''} · {usd(burn)}/h{a.budgetUsd ? ` of ${usd(a.budgetUsd)}` : ''}
          </Text>
          {a.hard.length > 0 && <Text color="error">⚠ {a.hard.join(' · ')}</Text>}
          <Box gap={1}>
            <Button key={`swap-${a.sid}`} label="Swap" onPress={() => void proposeSwap($, a, 'requested by the human', 'planned')} />
            <Button key={`compact-${a.sid}`} label="Compact" onPress={() => void sendCtl($, a.sid, { op: 'compact' }).then(() => $.ui.toast(`Asked ${a.name} to compact`))} />
            <Button key={`judge-${a.sid}`} label="Judge" onPress={() => void sendCtl($, a.sid, { op: 'judge' }).then(() => sendCtl($, a.sid, { op: 'canary' }))} />
            <Button
              key={`retire-${a.sid}`}
              label="Retire"
              onPress={() =>
                void $.ui.ask(`Retire ${a.name}?`, { options: ['Retire', 'Force', 'Cancel'], header: 'Retire' }).then(pick => {
                  if (pick === 'Retire' || pick === 'Force') return retire($, a, pick === 'Force')
                })
              }
            />
          </Box>
        </Box>
      )}
    </Box>
  )
}

function teamTab(E: Els, $: $T, board: Board, view: UiView, now: number, width: number): RenderElement {
  const { Box, Text } = E
  const active = board.lead.swaps.filter(s => !['done', 'failed', 'rejected', 'proposed'].includes(s.status))
  return (
    <Box flexDirection="column">
      <Text bold>TEAM <Text dimColor>· {board.agents.length} live · sharpness bar · context · spend</Text></Text>
      {board.agents.length === 0 && <Text dimColor>No workers yet. Ask for something and approve the brief: a hire starts automatically.</Text>}
      {board.agents.map(a => agentRow(E, $, a, board, view, now, width))}
      {active.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>SUCCESSION</Text>
          {active.map(s => (
            <Text key={`sw-${s.id}`} wrap="truncate-end">
              ⟳ {s.fromName} → {s.toName} <Text color="suggestion">{s.status}</Text> <Text dimColor>· {s.mode} · {short(s.reason, 60)}{s.disagreements?.length ? ` · ${s.disagreements.length} disagreements flagged` : ''}</Text>
            </Text>
          ))}
        </Box>
      )}
      {board.offline.length > 0 && <Text dimColor>{board.offline.length} offline: {board.offline.map(o => o.name).join(', ')}</Text>}
    </Box>
  )
}

function radarTab(E: Els, board: Board, now: number, width: number): RenderElement {
  const { Box, Text } = E
  const dirs = new Map<string, Set<string>>()
  for (const a of board.agents) {
    for (const r of a.repos) {
      if (now - r.at > 60 * 60_000) continue
      for (const f of r.files) {
        const d = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.'
        const set = dirs.get(d) ?? new Set<string>()
        set.add(a.name)
        dirs.set(d, set)
      }
    }
  }
  const rows = [...dirs.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 18)
  return (
    <Box flexDirection="column">
      <Text bold>COLLISION RADAR <Text dimColor>· merge dry-runs every 3 min · territory of the last hour</Text></Text>
      {board.conflicts.length === 0 ? (
        <Text color="success">No conflicts between live branches.</Text>
      ) : (
        board.conflicts.map(c => (
          <Text key={`c-${c.a}-${c.b}-${c.kind}`} color={c.kind === 'merge' ? 'error' : 'warning'} wrap="truncate-end">
            ⚡ {c.a} ↔ {c.b} {c.kind === 'merge' ? 'will conflict' : 'overlap'}: {c.files.join(', ')}
          </Text>
        ))
      )}
      <Text bold dimColor>TERRITORY</Text>
      {rows.length === 0 && <Text dimColor>Fog of war: nobody has edited anything yet.</Text>}
      {rows.map(([d, names]) => (
        <Text key={`t-${d}`} wrap="truncate-end">
          <Text color={names.size > 1 ? 'error' : 'subtle'}>{names.size > 1 ? '▓▓' : '░░'}</Text> {short(d, Math.max(20, width - 30)).padEnd(Math.min(40, Math.max(20, width - 30)))} <Text bold>{[...names].join(' ')}</Text>
        </Text>
      ))}
    </Box>
  )
}

function moneyTab(E: Els, board: Board): RenderElement {
  const { Box, Text } = E
  const spend = board.agents.reduce((s, a) => s + a.costUsd, 0)
  const merged = board.lead.merged
  const cpp = merged.length ? merged.reduce((s, m) => s + m.costUsd, 0) / merged.length : 0
  return (
    <Box flexDirection="column">
      <Text bold>TREASURY <Text dimColor>· live spend {usd(spend)} · merged {merged.length} · {merged.length ? `${usd(cpp)} per merged PR` : 'no merges yet'}</Text></Text>
      {board.agents.map(a => {
        const burn = board.burn[a.sid] ?? 0
        const budget = a.budgetUsd ?? 0
        const pct = budget ? (a.costUsd / budget) * 100 : 0
        const runway = burn > 0 && budget > a.costUsd ? ((budget - a.costUsd) / burn) * 60 : null
        return (
          <Text key={`m-${a.sid}`} wrap="truncate-end">
            {a.name.padEnd(12).slice(0, 12)} <Text color={pct > 100 ? 'error' : pct > 75 ? 'warning' : 'success'}>{bar(pct, 10)}</Text> {usd(a.costUsd)}
            {budget ? ` / ${usd(budget)}` : ''} <Text dimColor>· {usd(burn)}/h{runway !== null ? ` · runway ${Math.round(runway)} min` : ''}</Text>
          </Text>
        )
      })}
      {board.agents.length > 0 && <Text dimColor>burn {sparkline(board.agents.map(a => board.burn[a.sid] ?? 0))}</Text>}
      {board.lead.queue.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>REFINERY</Text>
          {board.lead.queue.slice(-6).map(q => (
            <Text key={`q-${q.url}`} wrap="truncate-end">
              {q.status === 'merged' ? '✓' : q.status === 'blocked' ? '✗' : '…'} {q.url.split('/').slice(-3).join('/')} <Text dimColor>{q.owner} · {q.status}{q.note ? ` · ${q.note}` : ''}</Text>
            </Text>
          ))}
        </Box>
      )}
    </Box>
  )
}

function replayTab(E: Els, $: $T, board: Board, view: UiView, now: number, width: number, rows: number): RenderElement {
  const { Box, Text, Button, Select } = E
  const names = [...new Set(board.events.map(e => e.name))]
  const events = board.events.filter(e => !view.replayAgent || e.name === view.replayAgent)
  const at = view.replayAt < 0 || view.replayAt >= events.length ? events.length - 1 : view.replayAt
  const span = Math.max(4, rows - 6)
  const start = Math.max(0, at - span + 3)
  const move = (to: number) => void setView($, { replayAt: Math.max(0, Math.min(events.length - 1, to)) })
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <Text bold>FLIGHT RECORDER <Text dimColor>· {events.length} events</Text></Text>
        <Button key="rp-first" label="«" plain onPress={() => move(0)} />
        <Button key="rp-prev" label="◀" hotkey="h" plain onPress={() => move(at - 1)} />
        <Button key="rp-next" label="▶" hotkey="l" plain onPress={() => move(at + 1)} />
        <Button key="rp-live" label="live" plain onPress={() => void setView($, { replayAt: -1 })} />
        {Select && (
          <Select key="rp-agent" options={[{ value: '', label: 'everyone' }, ...names.map(n => ({ value: n, label: n }))]} value={view.replayAgent} onSelect={v => void setView($, { replayAgent: v, replayAt: -1 })} />
        )}
      </Box>
      {events.slice(start, start + span).map((e, i) => (
        <Text key={`ev-${e.at}-${i}`} inverse={start + i === at} wrap="truncate-end">
          <Text dimColor>{ago(now, e.at).padStart(5)}</Text> <Text bold>{e.name.padEnd(10).slice(0, 10)}</Text> <Text color="suggestion">{e.kind.padEnd(8)}</Text> {short(e.text, width - 30)}
        </Text>
      ))}
    </Box>
  )
}

export function renderPane(E: Els, $: $T, board: Board, view: UiView, width: number, rows: number, now: number): RenderElement {
  const { Box } = E
  return (
    <Box flexDirection="column" width={width}>
      {header(E, $, board, view, now)}
      <Box flexDirection="column" marginTop={1}>
        {view.tab === 'inbox' && inboxTab(E, $, board, view, width, now)}
        {view.tab === 'team' && teamTab(E, $, board, view, now, width)}
        {view.tab === 'radar' && radarTab(E, board, now, width)}
        {view.tab === 'money' && moneyTab(E, board)}
        {view.tab === 'replay' && replayTab(E, $, board, view, now, width, rows)}
      </Box>
    </Box>
  )
}

export async function refreshBoard($: $T): Promise<void> {
  await update($, boardAtom, b => ({ ...b }))
}
