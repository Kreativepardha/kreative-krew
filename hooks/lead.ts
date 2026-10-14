// The Manager half: polls the crew, compiles and dispatches approved briefs,
// runs the Witness decisions and succession, the radar, the refinery,
// the treasury and the storyteller.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, On } from 'claude-code'

import type { Board, Brief, Card, Conflict, HandoffAccount, HandoffFacts, HandoffPacket, LeadState, Need, Swap } from '../types'
import { NO_ROLE, PANE, emptyBoard, initialView, runtime } from './core/atoms'
import { compileBrief, draftBrief, renderBrief } from './core/brief'
import {
  appendLog,
  ask,
  askJson,
  cfg,
  cliAgents,
  gitInfo,
  KEY,
  readCard,
  readCards,
  readLead,
  readLeadState,
  readLogs,
  readNotes,
  run,
  writeLeadState,
} from './core/io'
import { cleanName, encodeCtl, hash, isMember, isPrUrl, makeTag, rankNeeds, riskOf, shellJoin, short, slug, str, strings, successorName, uid, UUID, type Ctl } from './core/util'
import { assess, decide } from './core/witness'
import { clearDemo, demoHire, isDemo, seedDemo, tickDemo } from './core/demo'
import { boardText, flushCard, handoffFactsFor, resolveRole } from './worker'

const boardAtom = atom({ plugin: 'kreative-krew', key: 'board' } as const, emptyBoard())
const roleAtom = atom({ plugin: 'kreative-krew', key: 'role' } as const, NO_ROLE)
const viewAtom = atom({ plugin: 'kreative-krew', key: 'view' } as const, initialView())

type $T = EngineInterface

const L = {
  samples: new Map<string, [number, number][]>(),
  prStatus: new Map<string, { ci: 'pass' | 'fail' | 'pending' | 'none'; state: string; title: string; review: string }>(),
  conflicts: [] as Conflict[],
  lastPr: 0,
  lastRadar: 0,
  lastRefinery: 0,
  lastDigestCheck: 0,
  lastPrune: 0,
  notified: new Set<string>(),
  drafting: new Set<string>(),
  drafts: new Map<string, string>(),
  ctlSent: new Map<string, number>(),
  headsUp: new Set<string>(),
  polling: false,
  /** Serialises read-modify-write of krew:leadstate; a button press and the poll must not race. */
  leadLock: Promise.resolve(),
  /** Actions in flight (approve, swap, reply), so a double press sends nothing twice. */
  busy: new Set<string>(),
  statusRole: '' as string,
  timers: [] as { cancel: () => void }[],
}

/** Runs `fn` unless the same key is already running; resolves `idle` for the second caller. */
async function once<T>(key: string, idle: T, fn: () => Promise<T>): Promise<T> {
  if (L.busy.has(key)) return idle
  L.busy.add(key)
  try {
    return await fn()
  } finally {
    L.busy.delete(key)
  }
}

// ───────────────────────── role ─────────────────────────

export async function becomeLead($: $T): Promise<string> {
  const sid = await $.session.id()
  const token = uid('t') + uid()
  const root = await $.session.root().catch(() => undefined)
  await $.store.set(KEY.lead, { sid, token, since: await $.clock.now(), root })
  await $.store.delete(KEY.card(sid))
  runtime.role = 'lead'
  runtime.sid = sid
  runtime.token = token
  await update($, roleAtom, () => 'lead')
  L.statusRole = 'lead'
  $.ui.status('KREW · MANAGER')
  await poll($)
  await $.ui.open({ id: PANE, title: 'Krew' })
  return 'You are now the Manager. Sessions under this project that load Kreative Krew report here. Say what you want built; every brief waits for your approval.'
}

export async function refreshRole($: $T): Promise<void> {
  const lead = await readLead($)
  runtime.sid = runtime.sid || (await $.session.id())
  const role = await resolveRole($, lead)
  runtime.role = role
  runtime.token = lead?.token ?? ''
  await update($, roleAtom, () => role)
  if (L.statusRole !== role) {
    L.statusRole = role
    $.ui.status(role === 'lead' ? `KREW · MANAGER` : undefined)
  }
}

// ───────────────────────── messaging ─────────────────────────

export async function sendCtl($: $T, sid: string, ctl: Ctl): Promise<boolean> {
  if (isDemo(sid)) return true
  try {
    const r = await $.session.send({ to: { sessionId: sid }, text: encodeCtl(runtime.token, ctl) })
    return r.isDelivered
  } catch {
    return false
  }
}

export async function sendText($: $T, sid: string, text: string): Promise<boolean> {
  if (isDemo(sid)) return true
  try {
    const r = await $.session.send({ to: { sessionId: sid }, text })
    if (!r.isDelivered) $.ui.toast(`Not delivered: ${r.reason}`)
    return r.isDelivered
  } catch (error) {
    $.ui.toast(`Could not reach that session: ${String(error)}`)
    return false
  }
}

async function logLead($: $T, kind: string, text: string, ref?: string): Promise<void> {
  await appendLog($, { at: await $.clock.now(), sid: runtime.sid, name: 'Manager', kind, text: short(text, 240), ref })
}

async function mutateLead($: $T, change: (s: LeadState) => void): Promise<LeadState> {
  const turn = L.leadLock.then(async () => {
    const s = await readLeadState($)
    change(s)
    await writeLeadState($, s)
    await update($, boardAtom, b => ({ ...b, lead: s }))
    return s
  })
  L.leadLock = turn.then(() => undefined, () => undefined)
  return turn
}

// ───────────────────────── briefs ─────────────────────────

export async function createBrief($: $T, askText: string, opts: { assignees?: string[]; hireName?: string } = {}): Promise<Brief> {
  const now = await $.clock.now()
  let b = draftBrief(askText, now)
  b = { ...b, assignees: opts.assignees ?? [], hireName: cleanName(opts.hireName) || undefined }
  await mutateLead($, s => { s.briefs.push(b) })
  const board = await read($, boardAtom)
  const compiled = await compileBrief($, b, board.agents, board.notes)
  await mutateLead($, s => { s.briefs = s.briefs.map(x => (x.id === b.id ? compiled : x)) })
  await logLead($, 'brief', `${compiled.status === 'pending' ? 'compiled' : 'failed'}: ${compiled.title}`, compiled.id)
  if (compiled.status === 'pending') {
    await update($, viewAtom, v => ({ ...v, tab: 'inbox' as const, calm: false }))
    await $.ui.open({ id: PANE, title: 'Krew' })
    $.ui.toast(`Brief ready for your approval: ${compiled.title}`)
  }
  return compiled
}

export async function reviseBrief($: $T, id: string, instruction: string): Promise<void> {
  const s = await readLeadState($)
  const b = s.briefs.find(x => x.id === id)
  if (!b) return
  await mutateLead($, st => { st.briefs = st.briefs.map(x => (x.id === id ? { ...x, status: 'compiling' } : x)) })
  const board = await read($, boardAtom)
  const next = await compileBrief($, b, board.agents, board.notes, instruction)
  await mutateLead($, st => { st.briefs = st.briefs.map(x => (x.id === id ? next : x)) })
  $.ui.toast(next.status === 'pending' ? `Brief revised: ${next.title}` : `Revision failed: ${next.error}`)
}

export async function rejectBrief($: $T, id: string): Promise<void> {
  await mutateLead($, s => { s.briefs = s.briefs.map(x => (x.id === id ? { ...x, status: 'rejected' } : x)) })
  await logLead($, 'brief', 'rejected', id)
}

export async function approveBrief($: $T, id: string): Promise<string> {
  return once(`approve:${id}`, 'That brief is already being sent.', () => sendBrief($, id))
}

async function sendBrief($: $T, id: string): Promise<string> {
  const s = await readLeadState($)
  const b = s.briefs.find(x => x.id === id)
  if (!b || b.status !== 'pending') return 'That brief is not waiting for approval.'
  const board = await read($, boardAtom)
  const text = renderBrief(b)
  if (b.id.startsWith('demo-')) {
    const name = b.hireName || b.assignees[0] || 'Pixel'
    await demoHire($, name, b)
    await mutateLead($, st => { st.briefs = st.briefs.map(x => (x.id === id ? { ...x, status: 'sent', assignees: [name] } : x)) })
    $.ui.toast(`Hired ${name} (demo)`)
    return `Brief sent to ${name} (demo).`
  }
  const sentTo: string[] = []
  for (const name of b.assignees) {
    const card = board.agents.find(a => a.name.toLowerCase() === name.toLowerCase())
    if (!card) continue
    const tag = makeTag({ name: card.name, gen: card.gen, brief: b.id, budget: b.budgetUsd, goal: short(b.goal, 200), area: b.area.join(','), dnt: b.doNotTouch.join(','), lineage: card.lineage.join(','), worktree: card.worktree, branch: card.branch, ports: card.portBase, via: card.hiredVia })
    if (await sendText($, card.sid, `${tag}\n[Kreative Krew] New brief from the Manager, approved by the human:\n\n${text}`)) sentTo.push(card.name)
  }
  if (sentTo.length === 0) {
    const name = b.hireName || b.assignees[0] || 'Scout'
    const hired = await hire($, name, text, { briefId: b.id, area: b.area, dnt: b.doNotTouch, budget: b.budgetUsd, goal: b.goal })
    if (!hired.ok) {
      await mutateLead($, st => { st.briefs = st.briefs.map(x => (x.id === id ? { ...x, status: 'failed', error: hired.error } : x)) })
      return `Could not hire ${name}: ${hired.error}`
    }
    sentTo.push(name)
  }
  await mutateLead($, st => { st.briefs = st.briefs.map(x => (x.id === id ? { ...x, status: 'sent', assignees: sentTo } : x)) })
  await logLead($, 'brief', `sent to ${sentTo.join(', ')}: ${b.title}`, b.id)
  return `Brief sent to ${sentTo.join(', ')}.`
}

// ───────────────────────── hiring ─────────────────────────

type HireOpts = {
  briefId?: string
  area?: string[]
  dnt?: string[]
  budget?: number
  goal?: string
  worktree?: string
  branch?: string
  handoff?: string
  pred?: string
  gen?: number
  lineage?: string[]
  portBase?: number
}

async function freePortBase($: $T): Promise<number> {
  const used = new Set((await readCards($)).map(c => c.portBase).filter(Boolean))
  for (let base = 4100; base < 6000; base += 10) if (!used.has(base)) return base
  return 6000
}

export async function hire($: $T, rawName: string, briefText: string, o: HireOpts = {}): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const name = cleanName(rawName) || 'Scout'
  const root = await $.session.root()
  const info = await gitInfo($, root)
  let cwd = o.worktree ?? root
  let branch = o.branch
  if (!o.worktree && info) {
    const s = slug(name)
    const wt = `${info.common}/tmp/krew-${s}`
    branch = `krew/${s}`
    if (!(await $.fs.exists(wt))) {
      let r = await run($, ['git', 'worktree', 'add', '-b', branch, wt], info.common, 30_000)
      if (!r.ok) r = await run($, ['git', 'worktree', 'add', wt, branch], info.common, 30_000)
      if (r.ok) cwd = wt
      else $.ui.toast(`No worktree for ${name} (${short(r.err, 80)}); it works in the main checkout`)
    } else cwd = wt
  }
  const portBase = o.portBase ?? (await freePortBase($))
  if (cwd !== root) {
    await $.fs
      .write(`${cwd}/.env.krew`, `# Kreative Krew runtime isolation for ${name}\nKREW_NAME="${name}"\nPORT_BASE=${portBase}\nPORT=${portBase}\nDATABASE_NAME=krew_${slug(name).replace(/-/g, '_')}\n`)
      .catch(() => undefined)
  }
  const tmux = cfg.hireMode === 'tmux' && !!(await $.env.get('TMUX'))
  const tag = makeTag({
    name,
    gen: o.gen ?? 1,
    brief: o.briefId,
    budget: o.budget,
    goal: short(o.goal ?? '', 200),
    area: (o.area ?? []).join(','),
    dnt: (o.dnt ?? []).join(','),
    worktree: cwd !== root ? cwd : undefined,
    branch,
    ports: portBase,
    handoff: o.handoff,
    pred: o.pred,
    lineage: (o.lineage ?? []).join(','),
    via: tmux ? 'tmux' : 'bg',
  })
  const prompt = `${tag}\n${briefText}`
  const extra = cfg.claudeArgs.split(/\s+/).filter(Boolean)
  const model = cfg.workerModel ? ['--model', cfg.workerModel] : []
  // tmux hands its trailing words to a shell, so that command line is quoted as one string.
  const argv = tmux
    ? ['tmux', 'new-window', '-d', '-n', name, '-c', cwd, shellJoin(['claude', ...model, ...extra, '-n', name, prompt])]
    : ['claude', '--bg', ...model, ...extra, '-n', name, prompt]
  const r = await run($, argv, cwd, 60_000)
  if (!r.ok) return { ok: false, error: short(r.err || r.out, 200) }
  let sid = (r.out.match(UUID.source.replace(/^\^|\$$/g, '')) ?? [])[0]
  if (!sid) {
    await $.clock.sleep(2500)
    sid = (await cliAgents($)).find(a => a.name === name)?.sessionId
  }
  await logLead($, 'hire', `${name} started in ${cwd === root ? 'the main checkout' : cwd}`)
  $.ui.toast(`Hired ${name}`)
  return { ok: true, sid }
}

// ───────────────────────── retiring ─────────────────────────

export async function retire($: $T, card: Card, force: boolean): Promise<void> {
  await sendCtl($, card.sid, { op: 'retire', force })
  await logLead($, 'retire', `${force ? 'force-' : ''}retiring ${card.name}`)
  if (force) await teardown($, card, 'force-retired', true)
}

async function teardown($: $T, card: Card, report: string, removeWorktree: boolean): Promise<void> {
  if (isDemo(card.sid)) {
    await $.store.delete(KEY.card(card.sid))
    $.ui.toast(`${card.name} retired (demo)`)
    return
  }
  if (UUID.test(card.sid)) {
    if (card.hiredVia === 'tmux') await run($, ['tmux', 'kill-window', '-t', card.name], undefined, 10_000)
    else if (card.hiredVia === 'bg') await run($, ['claude', 'stop', card.sid], undefined, 20_000)
    else $.ui.toast(`${card.name} is retired: close its window when you like`)
  }
  if (removeWorktree && card.worktree && card.worktree.includes('/tmp/krew-')) {
    const r = await run($, ['git', 'worktree', 'remove', card.worktree], undefined, 30_000)
    if (!r.ok) report += ` · kept dirty worktree ${card.worktree}`
  }
  await $.store.delete(KEY.card(card.sid))
  await $.store.delete(KEY.retired(card.sid))
  await logLead($, 'retire', `${card.name} retired: ${short(report, 160)}`)
  $.ui.toast(`${card.name} retired: ${short(report, 120)}`)
}

// ───────────────────────── succession ─────────────────────────

export async function proposeSwap($: $T, card: Card, reason: string, mode: 'planned' | 'emergency'): Promise<Swap> {
  const now = await $.clock.now()
  const swap: Swap = {
    id: uid('s'),
    fromSid: card.sid,
    fromName: card.name,
    toName: successorName(card.name, card.gen + 1),
    gen: card.gen + 1,
    reason,
    mode,
    status: 'proposed',
    at: now,
    updatedAt: now,
  }
  await mutateLead($, s => { s.swaps.push(swap) })
  await logLead($, 'swap', `${mode} rotation proposed for ${card.name}: ${reason}`, swap.id)
  if (mode === 'planned') await startSwap($, swap.id)
  return swap
}

async function setSwap($: $T, id: string, patch: Partial<Swap>): Promise<void> {
  const now = await $.clock.now()
  await mutateLead($, s => { s.swaps = s.swaps.map(x => (x.id === id ? { ...x, ...patch, updatedAt: now } : x)) })
}

export async function startSwap($: $T, id: string): Promise<void> {
  await once(`swap:${id}`, undefined, async () => {
    const s = await readLeadState($)
    const swap = s.swaps.find(x => x.id === id)
    if (!swap || (swap.status !== 'proposed' && swap.status !== 'failed')) return
    const ok = await sendCtl($, swap.fromSid, { op: 'freeze', swapId: swap.id, reason: swap.reason })
    await setSwap($, id, ok ? { status: 'freezing' } : { status: 'failed', error: 'could not reach the worker' })
    $.ui.toast(ok ? `Rotating ${swap.fromName} → ${swap.toName}` : `Could not reach ${swap.fromName}`)
  })
}

export async function rejectSwap($: $T, id: string): Promise<void> {
  await setSwap($, id, { status: 'rejected' })
}

type RawHandoff = { raw: true; sid: string; name: string; goal: string; briefId?: string; facts: HandoffFacts; account: HandoffAccount }

const AUDIT_SYSTEM = `You audit a handoff between two AI coding agents. The predecessor may be degraded (long context) and may overclaim.
Compare its ACCOUNT with the FACTS from git and the event log. List concrete disagreements (claimed done but tests failing, claims about files that do not exist, missing failures, scope drift).
JSON {"disagreements":["one line each, max 8"],"goal":"the goal restated in one sentence"}`

async function auditAndSpawn($: $T, swap: Swap, card: Card | null, raw: RawHandoff | null): Promise<void> {
  await setSwap($, swap.id, { status: 'auditing' })
  const facts = raw?.facts ?? (card ? await handoffFactsFor($, card) : null)
  if (!facts) {
    await setSwap($, swap.id, { status: 'failed', error: 'no facts for the handoff' })
    return
  }
  const account: HandoffAccount = raw?.account ?? { done: [], decisions: [], deadEnds: [], gotchas: [], nextSteps: [], openQuestions: ['The predecessor gave no account; rebuild the picture from git and tests.'] }
  const st = await readLeadState($)
  const brief = st.briefs.find(b => b.id === (raw?.briefId ?? card?.briefId))
  const goal = brief?.goal || raw?.goal || card?.goal || card?.task || ''
  const audit = await askJson<{ disagreements?: unknown; goal?: string }>($, cfg.smartModel, AUDIT_SYSTEM, `GOAL (from the Manager): ${goal}\n\nFACTS:\n${JSON.stringify(facts, null, 1)}\n\nACCOUNT:\n${JSON.stringify(account, null, 1)}`, 900)
  const packet: HandoffPacket = {
    id: swap.id,
    goal,
    brief: brief ? renderBrief(brief) : undefined,
    facts,
    account,
    disagreements: strings(audit?.disagreements, 8),
    predecessor: { sid: swap.fromSid, name: swap.fromName, reason: swap.reason },
    createdAt: await $.clock.now(),
  }
  await $.store.set(KEY.handoff(swap.id), packet)
  await setSwap($, swap.id, { status: 'spawning', disagreements: packet.disagreements })
  const hired = await hire($, swap.toName, `[Kreative Krew] You are ${swap.toName}, taking over a task from ${swap.fromName}. Your handoff packet is attached; follow its startup ritual first.`, {
    briefId: brief?.id ?? card?.briefId,
    area: card?.area,
    dnt: card?.doNotTouch,
    budget: card?.budgetUsd,
    goal,
    worktree: card?.worktree,
    branch: card?.branch,
    handoff: swap.id,
    pred: swap.fromSid,
    gen: swap.gen,
    lineage: [...(card?.lineage ?? []), swap.fromName],
    portBase: card?.portBase,
  })
  await setSwap($, swap.id, hired.ok ? { status: 'warming', toSid: hired.sid } : { status: 'failed', error: hired.error })
  await logLead($, 'swap', hired.ok ? `${swap.toName} spawned with handoff (${packet.disagreements.length} disagreements flagged)` : `spawn failed: ${hired.error}`, swap.id)
}

/** Demo succession: the states tick every few seconds and a successor card appears. */
async function simulateDemoSwap($: $T, swap: Swap, from: Card | null, now: number): Promise<void> {
  if (now - swap.updatedAt < 6000) return
  const order: Swap['status'][] = ['freezing', 'auditing', 'spawning', 'warming', 'retiring', 'done']
  const next = order[order.indexOf(swap.status) + 1]
  if (!next) return
  if (next === 'warming' && from) {
    const succ: Card = { ...from, sid: `${from.sid}2`, name: swap.toName, gen: swap.gen, lineage: [...from.lineage, from.name], state: 'busy', contextPercent: 4, costUsd: 0.1, sharpness: 99, hard: [], mood: 'fresh', bullets: ['Read the handoff packet', 'Re-verifying the claimed-done items', 'Tests: 11/12 pass, one flake reproduced'], signals: { ...from.signals, repeats: 0, pingPong: 0, sameErrorFixes: 0, redoAfterCompact: 0, stallTurns: 0, canary: undefined, judge: undefined }, predecessor: from.sid, startedAt: now, lastActivityAt: now, heartbeatAt: now, lastProgressAt: now, turns: 1, warm: true, retiringAt: undefined, retiredReport: undefined, needs: [] }
    await $.store.set(KEY.card(succ.sid), succ)
  }
  if (next === 'done' && from) await $.store.delete(KEY.card(from.sid))
  await setSwap($, swap.id, { status: next, disagreements: next === 'auditing' ? ['Claims the flake is fixed, but the last test run still fails on the same assertion'] : swap.disagreements })
  if (next === 'done') $.ui.toast(`${swap.fromName} → ${swap.toName}: handoff complete`)
}

async function advanceSwaps($: $T, board: Board, now: number): Promise<void> {
  for (const swap of board.lead.swaps) {
    if (swap.status === 'done' || swap.status === 'failed' || swap.status === 'rejected' || swap.status === 'proposed') continue
    const from = board.agents.find(a => a.sid === swap.fromSid) ?? (await readCard($, swap.fromSid))
    if (isDemo(swap.fromSid)) {
      await simulateDemoSwap($, swap, from, now)
      continue
    }
    if (swap.status === 'freezing') {
      const raw = (await $.store.get(KEY.handoff(swap.id))) as RawHandoff | undefined
      if (raw?.raw || from?.handoffReady === swap.id) await auditAndSpawn($, swap, from, raw ?? null)
      else if (now - swap.updatedAt > 10 * 60_000) await auditAndSpawn($, swap, from, null)
    } else if (swap.status === 'warming') {
      const succ = board.agents.find(a => (swap.toSid ? a.sid === swap.toSid : a.name === swap.toName))
      if (succ?.warm || now - swap.updatedAt > 25 * 60_000) {
        if (from) await sendCtl($, from.sid, { op: 'retire' })
        await setSwap($, swap.id, { status: 'retiring', toSid: succ?.sid ?? swap.toSid })
      }
    } else if (swap.status === 'retiring') {
      if (!from) await setSwap($, swap.id, { status: 'done' })
      else if (from.retiredReport || now - swap.updatedAt > 10 * 60_000) {
        await teardown($, from, from.retiredReport ?? 'rotated out', false)
        await setSwap($, swap.id, { status: 'done' })
        $.ui.toast(`${swap.fromName} → ${swap.toName}: handoff complete`)
      } else continue
      // The successor read its packet at its first prompt; the store need not keep it.
      await $.store.delete(KEY.handoff(swap.id))
    }
  }
}

/** The Witness on the Manager's side: what to do about each worker. */
async function superviseQuality($: $T, board: Board, now: number): Promise<void> {
  const active = new Set(board.lead.swaps.filter(s => !['done', 'failed', 'rejected'].includes(s.status)).map(s => s.fromSid))
  for (const c of board.agents) {
    if (c.state === 'frozen' || c.state === 'retiring' || active.has(c.sid) || !c.task) continue
    const v = { sharpness: c.sharpness, hard: c.hard, soft: assess(c.signals, c.contextPercent, 0).soft }
    const { action, planned } = decide(v, c.contextPercent, cfg.rotateAt, !!c.rotateReady)
    const recent = board.lead.swaps.filter(s => s.toName === c.name && now - s.at < 30 * 60_000)
    if (action === 'swap') {
      if (recent.length > 0 && !planned) {
        const id = `split:${c.sid}`
        if (!board.lead.dismissed.includes(id) && !L.notified.has(id)) {
          L.notified.add(id)
          $.ui.toast(`${c.name} rots again within 30 min of its handoff: the task is likely too big; split it`)
        }
        continue
      }
      // A rotation the human ignored, or one that failed, is not proposed again for half an hour.
      const cooled = board.lead.swaps.some(s => s.fromSid === c.sid && (s.status === 'rejected' || s.status === 'failed') && now - s.updatedAt < 30 * 60_000)
      if (cooled) continue
      await proposeSwap($, c, planned ? `planned rotation at ${c.contextPercent}% context` : v.hard.join('; ') || `sharpness ${c.sharpness}`, planned ? 'planned' : 'emergency')
    } else if (action === 'judge') {
      if (now - (L.ctlSent.get(`judge:${c.sid}`) ?? 0) > 30 * 60_000) {
        L.ctlSent.set(`judge:${c.sid}`, now)
        await sendCtl($, c.sid, { op: 'judge' })
        if (cfg.canary) await sendCtl($, c.sid, { op: 'canary' })
      }
    } else if (action === 'compact' && c.state === 'idle') {
      if (now - (L.ctlSent.get(`compact:${c.sid}`) ?? 0) > 60 * 60_000) {
        L.ctlSent.set(`compact:${c.sid}`, now)
        await sendCtl($, c.sid, { op: 'compact' })
      }
    }
  }
}

// ───────────────────────── radar ─────────────────────────

async function radar($: $T, agents: Card[], now: number): Promise<void> {
  const found: Conflict[] = []
  const groups = new Map<string, { card: Card; branch: string }[]>()
  for (const c of agents) {
    const r = c.repos[0]
    if (!r || isDemo(c.sid)) continue
    const info = await gitInfo($, r.root)
    if (!info) continue
    const list = groups.get(info.common) ?? []
    list.push({ card: c, branch: info.branch })
    groups.set(info.common, list)
  }
  for (const [common, list] of groups) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]
        const b = list[j]
        const fa = new Set(a.card.repos.flatMap(r => (now - r.at < 30 * 60_000 ? r.files : [])))
        const overlap = b.card.repos.flatMap(r => (now - r.at < 30 * 60_000 ? r.files : [])).filter(f => fa.has(f))
        if (overlap.length) found.push({ a: a.card.name, b: b.card.name, files: overlap.slice(0, 6), kind: 'overlap', at: now })
        if (a.branch !== b.branch && a.branch !== 'HEAD' && b.branch !== 'HEAD') {
          const r = await run($, ['git', 'merge-tree', '--write-tree', '--name-only', '--no-messages', a.branch, b.branch], common, 20_000)
          if (!r.ok && r.out.trim()) {
            const files = r.out.trim().split('\n').slice(1).filter(Boolean)
            if (files.length) found.push({ a: a.card.name, b: b.card.name, files: files.slice(0, 8), kind: 'merge', at: now })
          }
        }
      }
    }
  }
  L.conflicts = found
  const keyOf = (c: Conflict) => `${c.kind}:${c.a}:${c.b}:${hash(c.files.join(','))}`
  for (const key of L.headsUp) if (!found.some(c => keyOf(c) === key)) L.headsUp.delete(key)
  for (const c of found) {
    const key = keyOf(c)
    if (L.headsUp.has(key)) continue
    L.headsUp.add(key)
    const text = c.kind === 'merge' ? `branches of ${c.a} and ${c.b} will conflict in ${c.files.join(', ')}. Agree who owns these files before going further.` : `${c.a} and ${c.b} both edited ${c.files.join(', ')} in the last 30 minutes.`
    for (const name of [c.a, c.b]) {
      const card = agents.find(x => x.name === name)
      if (card) await sendCtl($, card.sid, { op: 'heads-up', text })
    }
  }
}

// ───────────────────────── PRs and refinery ─────────────────────────

type GhPr = { state?: string; title?: string; reviewDecision?: string; mergeable?: string; mergeStateStatus?: string; statusCheckRollup?: { conclusion?: string | null; status?: string; state?: string }[] }

export function ciOf(rollup: GhPr['statusCheckRollup']): 'pass' | 'fail' | 'pending' | 'none' {
  if (!rollup || rollup.length === 0) return 'none'
  const states = rollup.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (states.some(s => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(s))) return 'fail'
  if (states.some(s => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING', ''].includes(s))) return 'pending'
  return 'pass'
}

async function ghPr($: $T, url: string, fields: string): Promise<GhPr | null> {
  const r = await run($, ['gh', 'pr', 'view', url, '--json', fields], undefined, 20_000)
  if (!r.ok) return null
  try {
    return JSON.parse(r.out) as GhPr
  } catch {
    return null
  }
}

async function checkPrs($: $T, agents: Card[]): Promise<void> {
  const urls = [...new Set(agents.filter(a => !isDemo(a.sid)).flatMap(a => a.prs.map(p => p.url)))]
  for (const url of urls) {
    const prev = L.prStatus.get(url)
    if (prev?.state === 'MERGED' || prev?.state === 'CLOSED') continue
    const pr = await ghPr($, url, 'state,title,reviewDecision,statusCheckRollup')
    if (pr) L.prStatus.set(url, { ci: ciOf(pr.statusCheckRollup), state: pr.state ?? '', title: pr.title ?? '', review: pr.reviewDecision ?? '' })
  }
}

export async function enqueueMerge($: $T, url: string, owner: string): Promise<void> {
  if (!isPrUrl(url)) {
    $.ui.toast(`Not a GitHub PR link: ${short(url, 60)}`)
    return
  }
  const now = await $.clock.now()
  await mutateLead($, s => {
    if (!s.queue.some(q => q.url === url && q.status !== 'merged')) s.queue.push({ url, owner, status: 'queued', at: now })
  })
  $.ui.toast(`Queued for the refinery: ${url.split('/').slice(-3).join('/')}`)
}

async function refinery($: $T, board: Board, now: number): Promise<void> {
  // Demo PRs sit in the queue for show; they never block a real one behind them.
  const demoOwner = (q: { owner: string }) => [...board.agents, ...board.offline].some(a => a.name === q.owner && isDemo(a.sid))
  const item = board.lead.queue.find(q => q.status !== 'merged' && q.status !== 'blocked' && !demoOwner(q))
  if (!item) return
  const pr = await ghPr($, item.url, 'state,mergeable,mergeStateStatus,statusCheckRollup,reviewDecision')
  const set = (patch: Partial<typeof item>) => mutateLead($, s => { s.queue = s.queue.map(q => (q.url === item.url ? { ...q, ...patch } : q)) })
  if (!pr) return
  if (pr.state === 'MERGED') {
    await set({ status: 'merged' })
    return
  }
  const owner = board.agents.find(a => a.name === item.owner)
  if (pr.mergeable === 'CONFLICTING') {
    await set({ status: 'blocked', note: 'conflicts with main' })
    if (owner) await sendCtl($, owner.sid, { op: 'heads-up', text: `Your PR ${item.url} conflicts with main. Rebase onto main; where a hunk conflicts, re-implement your change from its intent on top of the new code rather than hand-merging text. Push and tell the Manager.` })
    return
  }
  if (pr.mergeStateStatus === 'BEHIND') {
    const r = await run($, ['gh', 'pr', 'update-branch', item.url, '--rebase'], undefined, 60_000)
    await set({ status: r.ok ? 'rebasing' : 'blocked', note: r.ok ? 'rebased on main, CI rerunning' : short(r.err, 120) })
    return
  }
  const ci = ciOf(pr.statusCheckRollup)
  if (ci === 'pending') {
    await set({ status: 'checking' })
    return
  }
  if (ci === 'fail') {
    await set({ status: 'blocked', note: 'CI failing' })
    if (owner) await sendCtl($, owner.sid, { op: 'heads-up', text: `CI is failing on ${item.url}. Fix it before the refinery can merge.` })
    return
  }
  const r = await run($, ['gh', 'pr', 'merge', item.url, '--squash', '--delete-branch'], undefined, 90_000)
  if (r.ok) {
    await set({ status: 'merged' })
    await mutateLead($, s => { s.merged.push({ url: item.url, at: now, owner: item.owner, costUsd: owner?.costUsd ?? 0 }) })
    await logLead($, 'merge', `merged ${item.url}`)
    $.ui.toast(`Merged ${item.url.split('/').slice(-3).join('/')}`)
  } else await set({ status: 'blocked', note: short(r.err || r.out, 140) })
}

// ───────────────────────── inbox ─────────────────────────

function deriveInbox(agents: Card[], lead: LeadState, conflicts: Conflict[], now: number): Need[] {
  const out: Need[] = []
  for (const c of agents) for (const n of c.needs) out.push({ ...n, sid: c.sid, name: c.name })
  for (const b of lead.briefs) {
    if (b.status === 'pending' || b.status === 'compiling') out.push({ id: `brief:${b.id}`, kind: 'brief', text: b.status === 'compiling' ? `compiling: ${b.ask}` : b.title, risk: 2, at: b.createdAt, ref: b.id, name: b.assignees.join(', ') || b.hireName || 'new hire' })
    if (b.status === 'failed') out.push({ id: `brieffail:${b.id}`, kind: 'blocked', text: `brief failed: ${b.error ?? b.ask}`, risk: 2, at: b.createdAt, ref: b.id })
  }
  for (const s of lead.swaps) {
    if (s.status === 'proposed') out.push({ id: `swap:${s.id}`, kind: 'swap', text: `is degraded: ${s.reason}. Rotate to ${s.toName}?`, risk: 3, at: s.at, ref: s.id, name: s.fromName, sid: s.fromSid })
    if (s.status === 'failed') out.push({ id: `swapfail:${s.id}`, kind: 'blocked', text: `rotation of ${s.fromName} failed: ${s.error ?? '?'}`, risk: 2, at: s.updatedAt, ref: s.id })
  }
  for (const c of conflicts) out.push({ id: `conflict:${c.kind}:${c.a}:${c.b}:${hash(c.files.join(','))}`, kind: 'conflict', text: `${c.kind === 'merge' ? 'branches will conflict' : 'both edited'} ${c.files.slice(0, 3).join(', ')}`, risk: c.kind === 'merge' ? 2 : 1, at: c.at, name: `${c.a} ↔ ${c.b}` })
  for (const c of agents) {
    if (c.state === 'busy' && now - c.lastActivityAt > 20 * 60_000) out.push({ id: `stuck:${c.sid}:${c.lastActivityAt}`, kind: 'stuck', text: `busy with no activity for ${Math.round((now - c.lastActivityAt) / 60_000)} min`, risk: 3, at: c.lastActivityAt, sid: c.sid, name: c.name })
    if (c.budgetUsd && c.costUsd > c.budgetUsd * 1.5) out.push({ id: `runaway:${c.sid}`, kind: 'budget', text: `at ${Math.round((c.costUsd / c.budgetUsd) * 100)}% of its budget`, risk: 3, at: now, sid: c.sid, name: c.name })
    for (const p of c.prs) {
      const st = L.prStatus.get(p.url)
      if (st?.state === 'MERGED' || st?.state === 'CLOSED') continue
      if (st?.ci === 'pass' && p.evidence?.verdict !== 'fail' && !lead.queue.some(q => q.url === p.url)) {
        out.push({ id: `merge:${p.url}`, kind: 'pr', text: `ready to merge: ${st.title || p.url}`, url: p.url, risk: 1, at: p.at, sid: c.sid, name: c.name })
      }
    }
  }
  for (const d of lead.drills) if (!d.ackAt) out.push({ id: `drill:${d.id}`, kind: 'drill', text: `DRILL: ${d.name} reports main is broken (drill: press done to log your response time)`, risk: 3, at: d.at, ref: d.id, name: d.name })
  return rankNeeds(out.filter(n => !lead.dismissed.includes(n.id)))
}

export async function dismiss($: $T, need: Need): Promise<void> {
  const now = await $.clock.now()
  await mutateLead($, s => {
    s.dismissed.push(need.id)
    if (need.kind === 'drill' && need.ref) {
      const d = s.drills.find(x => x.id === need.ref)
      if (d && !d.ackAt) {
        d.ackAt = now
        $.ui.toast(`Drill answered in ${Math.round((now - d.at) / 1000)}s`)
      }
    }
  })
  await update($, boardAtom, b => ({ ...b, inbox: b.inbox.filter(n => n.id !== need.id) }))
}

export async function reply($: $T, need: Need, text: string): Promise<void> {
  if (!need.sid || !text.trim()) return
  await once(`reply:${need.id}`, undefined, async () => {
    const ok = await sendText($, need.sid ?? '', `[Kreative Krew] The human replies to "${short(need.text, 120)}": ${text}`)
    if (ok) {
      await dismiss($, need)
      await logLead($, 'reply', `to ${need.name}: ${text}`)
      $.ui.toast(`Sent to ${need.name}`)
    }
  })
}

/** Haiku pre-drafts replies to questions, in the background. */
async function draftReplies($: $T, inbox: Need[], board: Board): Promise<void> {
  for (const n of inbox.filter(x => (x.kind === 'question' || x.kind === 'approach') && !x.draft && !L.drafts.has(x.id) && !L.drafting.has(x.id)).slice(0, 3)) {
    L.drafting.add(n.id)
    const card = board.agents.find(a => a.sid === n.sid)
    const text = await ask(
      $,
      cfg.fastModel,
      'Draft a short reply (max 2 sentences) a pragmatic engineering manager would send to an AI coding agent. If options are given, pick one and say why in a few words. If you cannot judge, ask the one clarifying question that matters. No preamble.',
      `Agent ${n.name} working on: ${card?.task ?? '?'} (goal: ${card?.goal ?? '?'})\nIt asks: ${n.text}${n.options?.length ? `\nOptions: ${n.options.join(' | ')}` : ''}`,
      160,
    )
    if (text) L.drafts.set(n.id, text.trim())
  }
}

export function draftFor(id: string): string | undefined {
  return L.drafts.get(id)
}

// ───────────────────────── storyteller ─────────────────────────

function threshold(mode: LeadState['mode']): number {
  return mode === 'war' ? 0 : mode === 'steady' ? 2 : 3
}

async function announce($: $T, inbox: Need[], lead: LeadState): Promise<void> {
  const fresh = inbox.filter(n => !L.notified.has(n.id))
  for (const n of fresh) L.notified.add(n.id)
  const loud = fresh.filter(n => riskOf(n) >= threshold(lead.mode))
  if (loud.length === 0) return
  const top = loud[0]
  $.ui.toast(`${top.name ? `${top.name}: ` : ''}${short(top.text, 90)}${loud.length > 1 ? ` (+${loud.length - 1})` : ''}`)
  if (!lead.muted) await $.ui.notify(`${top.name ? `${top.name}: ` : ''}${short(top.text, 140)}`, { title: 'Kreative Krew' }).catch(() => undefined)
}

async function digestIfDue($: $T, lead: LeadState, now: number): Promise<void> {
  if (lead.mode !== 'focus') return
  const d = new Date(now)
  const day = d.toISOString().slice(0, 10)
  const hour = String(d.getHours())
  const key = `${day}:${hour}`
  if (!lead.digestHours.includes(hour) || lead.digestDay === key) return
  await mutateLead($, s => { s.digestDay = key })
  const text = await standup($)
  $.ui.log(`Kreative Krew digest\n${text}`)
  if (!lead.muted) await $.ui.notify('Your crew digest is ready', { title: 'Kreative Krew' }).catch(() => undefined)
}

// ───────────────────────── the poll ─────────────────────────

export async function poll($: $T): Promise<void> {
  if (L.polling) return
  L.polling = true
  try {
    await refreshRole($)
    if (runtime.role !== 'lead') return
    const now = await $.clock.now()
    const keys = await $.store.keys()
    const [rawCards, events, notes, lead] = await Promise.all([readCards($, keys), readLogs($, 400, keys), readNotes($, keys), readLeadState($)])
    const cards = await tickDemo($, rawCards, now, keys)
    // Defence in depth: a card from a session outside this crew (never hired, not under
    // the Manager's root) is ignored even if a stale worker wrote it.
    const leadRoot = (await readLead($))?.root
    const members = cards.filter(c => isDemo(c.sid) || !!c.hiredVia || !!c.briefId || isMember(leadRoot, [c.cwd, c.worktree], false, ''))
    const agents = members.filter(c => c.sid !== runtime.sid && now - c.heartbeatAt < 3 * 60_000)
    const offline = members.filter(c => c.sid !== runtime.sid && now - c.heartbeatAt >= 3 * 60_000)

    if (now - L.lastPrune > 3_600_000) {
      L.lastPrune = now
      void pruneStale($, offline, now).catch(() => undefined)
    }

    const burn: Record<string, number> = {}
    for (const sid of L.samples.keys()) if (!agents.some(c => c.sid === sid)) L.samples.delete(sid)
    for (const c of agents) {
      const list = (L.samples.get(c.sid) ?? []).filter(([t]) => now - t < 15 * 60_000)
      list.push([now, c.costUsd])
      L.samples.set(c.sid, list)
      const [t0, c0] = list[0]
      burn[c.sid] = now - t0 > 60_000 ? ((c.costUsd - c0) / (now - t0)) * 3_600_000 : 0
    }

    for (const c of agents.filter(x => x.retiredReport)) {
      const inSwap = lead.swaps.some(s => s.fromSid === c.sid && s.status === 'retiring')
      if (!inSwap) await teardown($, c, c.retiredReport ?? 'retired', true)
    }

    if (now - L.lastPr > 120_000) {
      L.lastPr = now
      void checkPrs($, agents)
    }
    if (now - L.lastRadar > 180_000) {
      L.lastRadar = now
      void radar($, agents, now)
    }
    if (agents.some(a => isDemo(a.sid)) && !L.conflicts.some(c => c.a === 'Atlas' && c.b === 'Nova')) {
      L.conflicts = [...L.conflicts, { a: 'Atlas', b: 'Nova', files: ['src/auth/login.ts'], kind: 'merge', at: now }]
    }

    const enriched = agents.map(c => ({ ...c, prs: c.prs.map(p => ({ ...p, ci: L.prStatus.get(p.url)?.ci ?? p.ci, title: L.prStatus.get(p.url)?.title ?? p.title, state: L.prStatus.get(p.url)?.state ?? p.state })) }))
    const inbox = deriveInbox(enriched, lead, L.conflicts, now).map(n => ({ ...n, draft: L.drafts.get(n.id) ?? n.draft }))
    const board: Board = { agents: enriched, offline, notes: notes.slice(-12), events, inbox, conflicts: L.conflicts, lead, burn, updatedAt: now }
    await update($, boardAtom, () => board)

    // Module memory follows the inbox: what left it is forgotten (split warnings stay).
    const open = new Set(inbox.map(n => n.id))
    for (const id of L.drafts.keys()) if (!open.has(id)) L.drafts.delete(id)
    for (const id of L.drafting) if (!open.has(id)) L.drafting.delete(id)
    for (const id of L.notified) if (!open.has(id) && !id.startsWith('split:')) L.notified.delete(id)

    await announce($, inbox, lead)
    void draftReplies($, inbox, board)
    await advanceSwaps($, board, now)
    await superviseQuality($, board, now)
    if (now - L.lastRefinery > 30_000) {
      L.lastRefinery = now
      await refinery($, board, now)
    }
    if (now - L.lastDigestCheck > 5 * 60_000) {
      L.lastDigestCheck = now
      await digestIfDue($, lead, now)
    }
  } catch (error) {
    $.ui.log(`Kreative Krew poll failed: ${String(error)}`, {})
  } finally {
    L.polling = false
  }
}

/** Cards (and their logs) of sessions silent for a day leave the store, so reads stay small. */
async function pruneStale($: $T, offline: Card[], now: number): Promise<void> {
  for (const c of offline) {
    if (isDemo(c.sid) || now - c.heartbeatAt < 24 * 3_600_000) continue
    await $.store.delete(KEY.card(c.sid))
    await $.store.delete(KEY.log(c.sid))
    await $.store.delete(KEY.retired(c.sid))
  }
}

// ───────────────────────── reports ─────────────────────────

export async function standup($: $T): Promise<string> {
  const board = await read($, boardAtom)
  const cards = board.agents.map(c => `${c.name} [${c.state}] ${c.task}: ${c.bullets.join('; ')} · ctx ${c.contextPercent}% · $${c.costUsd.toFixed(2)} · sharpness ${c.sharpness}`).join('\n')
  const needs = board.inbox.slice(0, 8).map(n => `${n.name ?? ''}: ${n.text}`).join('\n')
  const ev = board.events.slice(-40).map(e => `${e.name} ${e.kind}: ${e.text}`).join('\n')
  const text = await ask(
    $,
    cfg.fastModel,
    'Write a crew standup for a busy engineering manager in three sections: "Needs you", "Progress", "Risks". Under 220 words. Plain sentences, no code.',
    `AGENTS:\n${cards || 'none'}\n\nNEEDS:\n${needs || 'none'}\n\nRECENT EVENTS:\n${ev || 'none'}`,
    500,
  )
  return text ?? 'The standup model did not answer.'
}

export async function matchReport($: $T): Promise<string> {
  const board = await read($, boardAtom)
  const today = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const merged = board.lead.merged.filter(m => new Date(m.at).toISOString().startsWith(today))
  const spend = board.agents.reduce((s, a) => s + a.costUsd, 0)
  const text = await ask(
    $,
    cfg.fastModel,
    'You write a fun but factual end-of-day "match report" for an AI engineering crew, like a football match report. Sections: Score (PRs merged, spend, cost per merged PR), MVP, Best save, Nastiest bug, Biggest refactor, Tomorrow. Under 200 words. Only use facts given.',
    `Merged today: ${merged.map(m => `${m.owner} ${m.url}`).join(', ') || 'none'}\nSpend: $${spend.toFixed(2)}\nAgents:\n${board.agents.map(a => `${a.name}: ${a.task}; ${a.bullets.join('; ')}; mood ${a.mood}`).join('\n')}\nEvents:\n${board.events.slice(-80).map(e => `${e.name} ${e.kind}: ${e.text}`).join('\n')}`,
    600,
  )
  return text ?? 'The report model did not answer.'
}

export async function drill($: $T): Promise<string> {
  const board = await read($, boardAtom)
  const pick = board.agents[Math.floor(Math.random() * Math.max(1, board.agents.length))]
  const name = pick?.name ?? 'a worker'
  await mutateLead($, s => { s.drills.push({ id: uid('d'), at: Date.now(), name }) })
  return `Drill started: watch the inbox. Nothing real is broken.`
}

// ───────────────────────── commands ─────────────────────────

export const COMMANDS: { name: string; description: string; argumentHint?: string }[] = [
  { name: 'krew-lead', description: 'Kreative Krew: make this session the Manager' },
  { name: 'krew', description: 'Kreative Krew: toggle the crew dashboard' },
  { name: 'brief', description: 'Kreative Krew: compile a rough ask into a brief for your approval', argumentHint: '<what you want built>' },
  { name: 'assign', description: 'Kreative Krew: brief a specific agent (needs your approval)', argumentHint: '<agent> <task>' },
  { name: 'hire', description: 'Kreative Krew: brief a new hire (needs your approval)', argumentHint: '<Name> <task>' },
  { name: 'retire', description: 'Kreative Krew: retire an agent', argumentHint: '<agent> [force]' },
  { name: 'swap', description: 'Kreative Krew: rotate an agent to a fresh successor now', argumentHint: '<agent>' },
  { name: 'standup', description: 'Kreative Krew: crew digest (add "voice" to hear it)', argumentHint: '[voice]' },
  { name: 'krew-mode', description: 'Kreative Krew storyteller: focus | steady | war', argumentHint: '<focus|steady|war>' },
  { name: 'krew-push', description: 'Kreative Krew: desktop notifications on or off', argumentHint: '<on|off>' },
  { name: 'g', description: 'Kreative Krew control groups: /g 1 add a,b · /g 1 <order> · /g list', argumentHint: '<n> add|clear|<order>' },
  { name: 'match-report', description: 'Kreative Krew: end-of-day match report' },
  { name: 'krew-drill', description: 'Kreative Krew: run a fake incident to time your response' },
  { name: 'krew-demo', description: 'Kreative Krew: seed a fake crew to explore the dashboard (off to remove)', argumentHint: '[off]' },
]

const LEAD_ONLY = new Set(['krew-demo', 'brief', 'assign', 'hire', 'retire', 'swap', 'standup', 'krew-mode', 'krew-push', 'g', 'match-report', 'krew-drill'])

export async function runCommand($: $T, command: string, args: string): Promise<string> {
  if (command === 'krew-lead') return becomeLead($)
  if (LEAD_ONLY.has(command) && runtime.role !== 'lead') return 'Only the Manager can do that. Run /krew-lead in the session that should manage the crew.'
  const board = await read($, boardAtom)
  const findAgent = (name: string) => board.agents.find(a => a.name.toLowerCase() === name.toLowerCase() || a.name.toLowerCase().startsWith(name.toLowerCase()))
  const [first = '', ...restWords] = args.trim().split(/\s+/)
  const rest = restWords.join(' ')
  switch (command) {
    case 'krew': {
      const panes = await $.ui.panes()
      if (panes.some(p => p.id === PANE)) {
        await $.ui.close({ id: PANE })
        return 'Dashboard closed.'
      }
      const r = await $.ui.open({ id: PANE, title: 'Krew' })
      return r.isPlaced ? 'Dashboard open.' : `Dashboard waits for room: ${r.reason}`
    }
    case 'brief': {
      if (!args.trim()) return 'Usage: /brief <what you want built>'
      const b = await createBrief($, args.trim())
      return b.status === 'pending' ? `Brief ${b.id} "${b.title}" is waiting for your approval in the dashboard.` : `Brief failed: ${b.error}`
    }
    case 'assign': {
      const a = findAgent(first)
      if (!a || !rest) return 'Usage: /assign <agent> <task>'
      const b = await createBrief($, rest, { assignees: [a.name] })
      return b.status === 'pending' ? `Brief for ${a.name} is waiting for your approval.` : `Brief failed: ${b.error}`
    }
    case 'hire': {
      const hireName = cleanName(first)
      if (!hireName || !rest) return 'Usage: /hire <Name> <task> (letters, digits and hyphens in the name)'
      const b = await createBrief($, rest, { hireName })
      return b.status === 'pending' ? `Brief for new hire ${hireName} is waiting for your approval.` : `Brief failed: ${b.error}`
    }
    case 'retire': {
      const a = findAgent(first)
      if (!a) return 'Usage: /retire <agent> [force]'
      const pick = await $.ui.ask(`Retire ${a.name}?`, { options: ['Retire', 'Force', 'Cancel'], header: 'Retire' })
      if (pick === 'Cancel' || !pick) return 'Cancelled.'
      await retire($, a, pick === 'Force' || rest === 'force')
      return `${a.name} is retiring.`
    }
    case 'swap': {
      const a = findAgent(first)
      if (!a) return 'Usage: /swap <agent>'
      const s = await proposeSwap($, a, 'requested by the human', 'planned')
      return `Rotating ${a.name} → ${s.toName}.`
    }
    case 'standup': {
      const text = await standup($)
      if (first === 'voice') void $.audio.speak(text).catch(() => undefined)
      return text
    }
    case 'krew-mode': {
      const mode = (['focus', 'steady', 'war'] as const).find(m => m === first)
      if (!mode) return 'Usage: /krew-mode focus|steady|war'
      await mutateLead($, s => { s.mode = mode })
      return mode === 'focus' ? `Focus mode: only high-risk items interrupt you; digests at ${board.lead.digestHours.join(':00, ')}:00.` : mode === 'war' ? 'War-room mode: everything interrupts you.' : 'Steady mode: medium and high risk interrupt you.'
    }
    case 'krew-push': {
      await mutateLead($, s => { s.muted = first === 'off' })
      return first === 'off' ? 'Desktop notifications off.' : 'Desktop notifications on.'
    }
    case 'g': {
      if (first === 'list' || !first) return Object.entries(board.lead.groups).map(([k, v]) => `${k}: ${v.join(', ')}`).join('\n') || 'No groups yet. /g 1 add Atlas,Nova'
      if (restWords[0] === 'add') {
        const names = restWords.slice(1).join(' ').split(/[,\s]+/).map(n => findAgent(n)?.name).filter((n): n is string => !!n)
        await mutateLead($, s => { s.groups[first] = [...new Set([...(s.groups[first] ?? []), ...names])] })
        return `Group ${first}: ${names.join(', ')}`
      }
      if (restWords[0] === 'clear') {
        await mutateLead($, s => { delete s.groups[first] })
        return `Group ${first} cleared.`
      }
      const members = board.lead.groups[first] ?? []
      if (!members.length || !rest) return `Group ${first} is empty. /g ${first} add <agents>`
      const b = await createBrief($, rest, { assignees: members })
      return b.status === 'pending' ? `Group order for ${members.join(', ')} is waiting for your approval.` : `Brief failed: ${b.error}`
    }
    case 'match-report':
      return matchReport($)
    case 'krew-drill':
      return drill($)
    case 'krew-demo': {
      const text = first === 'off' ? await clearDemo($) : await seedDemo($)
      await poll($)
      if (first !== 'off') {
        await update($, viewAtom, v => ({ ...v, tab: 'inbox' as const }))
        await $.ui.open({ id: PANE, title: 'Krew', focus: true })
      }
      return text
    }
  }
  return `Unknown command ${command}`
}

// ───────────────────────── manager tools ─────────────────────────

export async function registerLeadTools($: $T): Promise<void> {
  await $.tool.register({
    name: 'krew_brief',
    description: 'Kreative Krew (Manager only): delegate work. Pass the human\'s rough ask; it is compiled into a structured brief and shown to the human for approval before any worker gets it. Use for EVERY piece of work that changes code.',
    inputSchema: {
      type: 'object',
      properties: {
        ask: { type: 'string', description: 'what the human wants, in their words plus any context you know' },
        assignees: { type: 'array', items: { type: 'string' }, description: 'existing agent names, optional' },
        hire_name: { type: 'string', description: 'name for a new hire, optional' },
      },
      required: ['ask'],
    },
    isDeferred: false,
  })
}

export async function answerLeadTool($: $T, name: string, input: Record<string, unknown>): Promise<{ result: string } | { isError: true; result: string }> {
  if (name !== 'krew_brief') return { isError: true, result: 'unknown tool' }
  if (runtime.role !== 'lead') return { isError: true, result: 'Only the Manager session can brief workers.' }
  const askText = str(input.ask)
  if (!askText) return { isError: true, result: 'ask is required' }
  const b = await createBrief($, askText, { assignees: strings(input.assignees, 6, 40), hireName: str(input.hire_name) || undefined })
  if (b.status !== 'pending') return { isError: true, result: `The brief could not be compiled: ${b.error}` }
  return { result: `Brief ${b.id} "${b.title}" is compiled and waiting for the human's approval in the Krew dashboard (Approve / Revise / Reject). It goes to ${b.assignees.join(', ') || `a new hire named ${b.hireName}`}. Do not do the work yourself.` }
}

export const LEAD_SECTION = `## Kreative Krew: you are the MANAGER of an AI engineering crew
- You never edit code; Edit/Write are blocked in this session. When the human asks for any work that changes code, call krew_brief with their ask (plus context you know). The mod compiles a structured brief and the human approves it before any worker sees it. Never skip this, even for small changes.
- Use krew_board for crew status. The Krew dashboard (/krew) shows the inbox, team, radar, money and replay.
- Split work along file and module boundaries so each area has one writer; give overlapping work to the agent that already owns that area.
- When a worker reports done, check its PR evidence (reviewer, tests, goal check) before recommending a merge.
- Keep your own answers short: the human manages through the dashboard.`

export function registerLead(on: On): void {
  on('tool.call', { tool: 'Edit' }, ($, e, next) => (runtime.role === 'lead' ? { deny: 'Kreative Krew: the Manager does not edit code. Delegate with krew_brief; the human approves the brief.' } : next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'Write' }, ($, e, next) => (runtime.role === 'lead' ? { deny: 'Kreative Krew: the Manager does not write files. Delegate with krew_brief; the human approves the brief.' } : next(e))).catch(($, e, next) => next(e))
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => (runtime.role === 'lead' ? { deny: 'Kreative Krew: the Manager does not edit code. Delegate with krew_brief.' } : next(e))).catch(($, e, next) => next(e))
}

export async function startLeadTimers($: $T): Promise<void> {
  for (const t of L.timers) t.cancel()
  L.timers = [
    $.clock.every(5000, () => void poll($)),
    $.clock.every(5000, () => void flushCard($)),
  ]
}

export async function boardForTool($: $T): Promise<string> {
  return boardText($)
}
