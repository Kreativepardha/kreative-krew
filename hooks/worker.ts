// The worker half: every session that is not the Manager keeps a status card,
// feeds the Witness, serves the crew tools and obeys the Manager's controls.

import { atom, update } from 'claude-code'
import type { EngineInterface, On, ToolCallResult } from 'claude-code'

import type { Card, HandoffAccount, HandoffFacts, HandoffPacket, Need, NeedKind, Role } from '../types'
import { NO_CARD, runtime } from './core/atoms'
import { isDemo } from './core/demo'
import {
  appendLog,
  appendNote,
  askJson,
  cfg,
  cliAgents,
  dirOf,
  gitInfo,
  KEY,
  readCard,
  readCards,
  readLead,
  readNotes,
  run,
  writeCard,
  type LeadRecord,
} from './core/io'
import {
  decodeCtl,
  emptyCard,
  isMember,
  moodOf,
  parseTag,
  PR_URL,
  relTo,
  short,
  str,
  stripMarkup,
  strings,
  uid,
} from './core/util'
import { assess, breaksRules, errorRate, isCorrection, isTestCommand, markCompaction, newWitness, observe } from './core/witness'

const meAtom = atom({ plugin: 'kreative-krew', key: 'me' } as const, NO_CARD)

type $T = EngineInterface

export const TOOL = (name: string) => `mcp__kreative-krew__${name}`

const W = {
  card: null as Card | null,
  witness: newWitness(),
  dirty: false,
  lastWrite: 0,
  lastPrompt: '',
  turnProgress: false,
  turnBoundary: false,
  bashFails: { cmd: '', count: 0 },
  recentTurns: [] as { prompt: string; answer: string }[],
  lastNoteAt: 0,
  pendingVerify: new Map<string, { url: string; kind: 'reviewer' | 'tests' | 'goal' }>(),
  lastCollisionCheck: new Map<string, number>(),
  loggedEdit: new Map<string, number>(),
  hasLead: false,
  freezeSwap: '',
  pendingCompact: '' as string,
  tagSeen: false,
  handoff: null as HandoffPacket | null,
  /** Where this session lives, for the membership rule. */
  paths: [] as (string | undefined)[],
  envName: '',
  /** The card carrying retiredReport was written once; later flushes would only resurrect it. */
  retiredWritten: false,
}

/** Lead, member worker, or inert: the one place the role is decided. */
export async function resolveRole($: $T, lead: LeadRecord | null): Promise<Role> {
  if (!lead) return 'none'
  if (lead.sid === runtime.sid) return 'lead'
  if (W.paths.length === 0) {
    const cwd = await $.session.cwd()
    const root = await $.session.root().catch(() => undefined)
    const info = await gitInfo($, cwd)
    W.paths = [cwd, root, info?.root, info?.common]
    W.envName = (await $.env.get('KREW_NAME')) ?? ''
  }
  return isMember(lead.root, W.paths, W.tagSeen, W.envName) ? 'worker' : 'none'
}

/** Card the drawing and the tools read; created lazily. */
export function workerCard(): Card | null {
  return W.card
}

async function touch($: $T, change: (c: Card) => void, flush = false): Promise<void> {
  if (!W.card) return
  change(W.card)
  W.dirty = true
  if (flush) await flushCard($)
}

export async function flushCard($: $T): Promise<void> {
  const c = W.card
  if (!c || !W.dirty || runtime.role !== 'worker' || !W.hasLead || W.retiredWritten) return
  W.dirty = false
  const verdict = assess(c.signals, c.contextPercent, errorRate(W.witness), {})
  c.sharpness = verdict.sharpness
  c.hard = verdict.hard
  c.mood = moodOf(c)
  W.lastWrite = await $.clock.now()
  await writeCard($, c)
  if (c.retiredReport) W.retiredWritten = true
  await update($, meAtom, () => ({ ...c }))
}

export async function logEvent($: $T, kind: string, text: string, ref?: string): Promise<void> {
  if (!W.card || !W.hasLead || runtime.role !== 'worker') return
  await appendLog($, { at: await $.clock.now(), sid: W.card.sid, name: W.card.name, kind, text: short(text, 240), ref })
}

async function addNeed($: $T, kind: NeedKind, text: string, extra?: Partial<Need>): Promise<void> {
  const now = await $.clock.now()
  await touch($, c => {
    c.needs = [
      ...c.needs.filter(n => !(n.kind === kind && n.text === text)),
      { id: uid('n'), kind, text: short(text, 300), risk: 1, at: now, sid: c.sid, name: c.name, ...extra },
    ].slice(-8)
    if (kind === 'question' || kind === 'approach' || kind === 'blocked' || kind === 'permission') c.state = 'waiting'
  }, true)
  await logEvent($, 'need', `${kind}: ${text}`)
}

async function resolveName($: $T, sid: string): Promise<string> {
  const env = await $.env.get('KREW_NAME')
  if (env) return env
  const mine = (await cliAgents($)).find(a => a.sessionId === sid)
  return mine?.name ?? `agent-${sid.slice(0, 4)}`
}

/** Called from session.start: identity, card and timers. */
export async function startWorker($: $T): Promise<void> {
  const sid = await $.session.id()
  runtime.sid = sid
  const cwd = await $.session.cwd()
  const now = await $.clock.now()
  const lead = await readLead($)
  W.hasLead = !!lead
  runtime.role = await resolveRole($, lead)
  runtime.token = lead?.token ?? ''
  const existing = await readCard($, sid)
  W.card = existing ?? emptyCard(sid, `agent-${sid.slice(0, 4)}`, now, cwd)
  if (!existing) {
    void resolveName($, sid).then(name => touch($, c => { if (c.name.startsWith('agent-')) c.name = name }, true)).catch(() => undefined)
  }
  W.dirty = true
  await flushCard($)
}

/** Every 60s: heartbeat, lead discovery, pending compaction. */
export async function heartbeat($: $T): Promise<void> {
  const lead = await readLead($)
  W.hasLead = !!lead
  runtime.role = await resolveRole($, lead)
  runtime.token = lead?.token ?? ''
  if (runtime.role !== 'worker') return
  const now = await $.clock.now()
  await touch($, c => { c.heartbeatAt = now })
  await flushCard($)
}

function teamSection(c: Card): string {
  const lines = [
    `## Kreative Krew: you are "${c.name}"${c.gen > 1 ? ` (generation ${c.gen})` : ''} on an AI engineering crew`,
    '- A Manager session coordinates the crew and a human approves every brief.',
    '- Call krew_board before starting new work: it lists teammates, their areas and recent notes.',
    c.area.length ? `- You own (may edit): ${c.area.join(', ')}. Ask before editing anything else.` : '- Keep your edits to the area your brief names.',
    c.doNotTouch.length ? `- Never touch: ${c.doNotTouch.join(', ')}.` : '',
    c.worktree ? `- Work only in your worktree ${c.worktree} on branch ${c.branch ?? '(yours)'}.` : '- Work in your own git worktree under <project root>/tmp/, never in a teammate\'s checkout.',
    c.portBase ? `- Ports ${c.portBase}-${c.portBase + 9} and the database named in .env.krew are yours alone.` : '',
    '- Post durable learnings and failed approaches with krew_note so teammates do not repeat them.',
    '- Use ask_manager (kind question|approach|blocked|pr) for product decisions; batch approach choices into one question.',
    '- Commit at natural boundaries. When done, open a PR and report as the brief says.',
    '- Messages starting with [Kreative Krew] come from the Manager harness: follow them.',
  ]
  return lines.filter(Boolean).join('\n')
}

export function workerSection(): string | null {
  return runtime.role === 'worker' && W.card ? teamSection(W.card) : null
}

function handoffText(p: HandoffPacket): string {
  const l = (t: string, xs: string[]) => (xs.length ? `\n### ${t}\n${xs.map(x => `- ${x}`).join('\n')}` : '')
  return [
    `# Handoff packet ${p.id}: you are taking over from ${p.predecessor.name}`,
    `Reason for rotation: ${p.predecessor.reason}`,
    `\n## Goal (from the Manager)\n${p.goal}`,
    p.brief ? `\n## Original brief\n${p.brief}` : '',
    `\n## Ground truth (from git and the event log, trust these)`,
    `- cwd: ${p.facts.cwd}`,
    `- branch: ${p.facts.branch ?? '—'} @ ${p.facts.head ?? '—'}`,
    `- uncommitted: ${p.facts.dirty.join(', ') || 'none'}`,
    `- last test: ${p.facts.lastTest ?? 'unknown'}`,
    l('Open failures (verbatim)', p.facts.failures),
    l('Key files', p.facts.keyFiles),
    l('PRs', p.facts.prs),
    `\n## Predecessor's account (audit it, do not trust blindly)`,
    l('Claimed done (re-verify each)', p.account.done),
    l('Decisions', p.account.decisions),
    l('Dead ends (do not retry)', p.account.deadEnds),
    l('Gotchas', p.account.gotchas),
    l('Next steps', p.account.nextSteps),
    l('Open questions', p.account.openQuestions),
    l('Auditor flagged these disagreements', p.disagreements),
    '\n## Startup ritual',
    '1. Read git log -10 and git status; run the tests.',
    '2. Re-verify every "claimed done" item against the code and tests.',
    '3. Restate the plan in 3 lines.',
    '4. Call krew_warmup_done with what you verified and any discrepancies. Use ask_predecessor for anything missing while it is still around.',
  ].join('\n')
}

/** prompt.submit: adopts a hire tag, counts corrections, attaches notes. */
export async function onPromptSubmit($: $T, text: string, isHuman: boolean): Promise<{ text: string; context: string[] }> {
  const context: string[] = []
  let out = text
  const tag = parseTag(text)
  if (tag && W.card) {
    const a = tag.attrs
    out = tag.rest
    W.tagSeen = true
    const lead = await readLead($)
    W.hasLead = !!lead
    runtime.role = 'worker'
    await touch($, c => {
      c.name = a.name || c.name
      c.gen = Number(a.gen) || 1
      c.briefId = a.brief || c.briefId
      c.worktree = a.worktree || c.worktree
      c.branch = a.branch || c.branch
      c.portBase = Number(a.ports) || c.portBase
      c.budgetUsd = Number(a.budget) || c.budgetUsd
      c.goal = a.goal || c.goal
      c.area = a.area ? a.area.split(',').filter(Boolean) : c.area
      c.doNotTouch = a.dnt ? a.dnt.split(',').filter(Boolean) : c.doNotTouch
      c.predecessor = a.pred || undefined
      c.lineage = a.lineage ? a.lineage.split(',').filter(Boolean) : c.lineage
      c.hiredVia = a.via === 'tmux' || a.via === 'bg' ? a.via : c.hiredVia ?? 'manual'
    }, true)
    if (a.handoff) {
      const p = (await $.store.get(KEY.handoff(a.handoff))) as HandoffPacket | undefined
      if (p && p.facts) {
        W.handoff = p
        context.push(handoffText(p))
      }
    }
    await logEvent($, 'hired', `${W.card.name} started${a.handoff ? ' from a handoff' : ''}`)
  }

  if (runtime.role === 'worker' && W.card) {
    if (isHuman && isCorrection(out) && W.witness.editedThisTurn) {
      await touch($, c => { c.signals.corrections++ })
    }
    const notes = (await readNotes($)).filter(n => n.at > W.lastNoteAt && n.sid !== W.card?.sid)
    if (notes.length > 0) {
      W.lastNoteAt = notes[notes.length - 1].at
      context.push(`Kreative Krew: new team notes since your last turn:\n${notes.slice(-6).map(n => `- ${n.name}: ${n.text}`).join('\n')}`)
    }
  }
  return { text: out, context }
}

export async function onTurnStart($: $T, text: string): Promise<void> {
  if (!W.card) return
  W.lastPrompt = text
  W.turnProgress = false
  W.turnBoundary = false
  W.witness.editedThisTurn = false
  const now = await $.clock.now()
  await touch($, c => {
    if (c.state !== 'frozen' && c.state !== 'retiring') c.state = 'busy'
    c.needs = c.needs.filter(n => n.kind === 'pr' || n.kind === 'budget')
    c.lastActivityAt = now
  })
}

type Summary = { task?: string; bullets?: unknown; needs?: { kind?: string; text?: string; url?: string; options?: unknown }[] }

const CARD_SYSTEM = `You write a status card for an AI coding agent on a team, for a busy human manager.
From the user's prompt and the agent's final answer, return JSON:
{"task":"<=8 words, what it is working on","bullets":["<=3 plain-English outcomes, no code, no file paths, no tool names"],"needs":[{"kind":"question|approach|pr|blocked","text":"one line","url":"optional","options":["optional short choices"]}]}
needs only when the agent explicitly asks the human something, offers a choice of approaches (kind approach, list options), waits for a merge/review (pr), or says it is blocked.`

async function summarize($: $T, prompt: string, answer: string): Promise<void> {
  const s = await askJson<Summary>($, cfg.fastModel, CARD_SYSTEM, `PROMPT:\n${short(prompt, 1500)}\n\nANSWER:\n${answer.slice(-4000)}`, 500)
  const now = await $.clock.now()
  const fallback = short(stripMarkup(answer).split(/(?<=[.!?])\s/)[0] ?? '', 90)
  await touch($, c => {
    c.task = short(str(s?.task, c.task || fallback), 60)
    const bullets = strings(s?.bullets, 3, 140)
    c.bullets = bullets.length ? bullets : fallback ? [fallback] : c.bullets
    for (const n of s?.needs ?? []) {
      const kind = (['question', 'approach', 'pr', 'blocked'] as const).find(k => k === n.kind)
      if (!kind || !n.text) continue
      if (c.needs.some(x => x.text === n.text)) continue
      c.needs.push({ id: uid('n'), kind, text: short(n.text, 300), url: n.url, options: strings(n.options, 5, 60), risk: 1, at: now, sid: c.sid, name: c.name })
      if (kind !== 'pr') c.state = 'waiting'
    }
  }, true)
}

export async function onTurnComplete($: $T, answer: string, agentId: string | undefined): Promise<void> {
  if (agentId) return onAgentAnswer($, agentId, answer)
  if (!W.card || runtime.role !== 'worker') return
  const now = await $.clock.now()
  W.recentTurns.push({ prompt: short(W.lastPrompt, 600), answer: short(answer, 1200) })
  if (W.recentTurns.length > 6) W.recentTurns.shift()
  await touch($, c => {
    c.turns++
    c.signals.stallTurns = W.turnProgress ? 0 : c.signals.stallTurns + 1
    if (c.state === 'busy') c.state = 'idle'
    c.lastActivityAt = now
    c.rotateReady = c.contextPercent >= cfg.rotateAt && (W.turnBoundary || c.state === 'idle')
  }, true)
  void summarize($, W.lastPrompt, answer).catch(() => undefined)
  if (W.pendingCompact) {
    const focus = W.pendingCompact
    W.pendingCompact = ''
    $.clock.after(1500, () => void compactSelf($, focus).catch(() => undefined))
  }
}

async function compactSelf($: $T, focus: string): Promise<void> {
  try {
    const r = await $.session.compact({ instructions: focus || 'Keep the goal, the plan, decisions with their reasons, dead ends and open questions verbatim.' })
    await logEvent($, 'compact', r && 'skip' in r && r.skip ? `compaction skipped: ${r.skip}` : 'compacted on the Manager\'s request')
  } catch {
    W.pendingCompact = focus || 'keep plan'
  }
}

export async function onCompacted($: $T): Promise<void> {
  markCompaction(W.witness)
  await touch($, c => { c.signals = { ...W.witness.signals } }, true)
  await logEvent($, 'compact', 'context compacted')
}

export async function onMeasure($: $T, percent: number | undefined, costUsd: number | undefined): Promise<void> {
  if (!W.card) return
  const before = W.card.costUsd
  await touch($, c => {
    if (percent !== undefined) c.contextPercent = Math.round(percent)
    if (costUsd !== undefined) c.costUsd = costUsd
  })
  const c = W.card
  if (c.budgetUsd && c.costUsd > c.budgetUsd && before <= c.budgetUsd) {
    await addNeed($, 'budget', `over budget: $${c.costUsd.toFixed(2)} of $${c.budgetUsd.toFixed(2)}`, { risk: 2 })
  }
  if ((await $.clock.now()) - W.lastWrite > 15_000) await flushCard($)
}

export async function onNotification($: $T, type: string, message: string): Promise<void> {
  if (!W.card || runtime.role !== 'worker') return
  if (type === 'permission_prompt') await addNeed($, 'permission', message || 'waiting for a permission', { risk: 2 })
  else if (type === 'idle_prompt') await touch($, c => { if (c.state === 'busy') c.state = 'idle' }, true)
}

type Loose = Record<string, unknown>

/** Observes one finished tool call (any tool). */
export async function observeTool($: $T, input: Loose, ran: ToolCallResult): Promise<void> {
  if (!W.card || runtime.role !== 'worker') return
  const tool = str(input.tool)
  if (tool.startsWith('mcp__kreative-krew__')) return
  const now = await $.clock.now()
  const file = str(input.file_path) || str(input.notebook_path)
  const command = str(input.command)
  const isEdit = tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit' || tool === 'MultiEdit'
  const isRead = tool === 'Read'
  const isError = ran.isError === true || ran.deny !== undefined
  const result = (ran.result ?? {}) as Loose
  const errorText = isError ? str(ran.text) || str(result.stderr) || str(result.stdout) || str(ran.deny) : ''
  const isTest = tool === 'Bash' && isTestCommand(command)
  const git = (result.gitOperation ?? {}) as { commit?: { sha: string }; pr?: { url?: string; action: string } }
  const key = short(command || file || str(input.pattern) || str(input.url) || JSON.stringify(input).slice(0, 200), 200)

  const moved = observe(W.witness, { tool, key, isError, errorText, file, isEdit, isRead, isTest, isProgress: false })
  const progress = (!isError && (isTest || !!git.commit || !!git.pr)) || (isEdit && !isError)
  if (progress) {
    W.turnProgress = true
    if (isTest || git.commit || git.pr) W.turnBoundary = true
  }

  await touch($, c => {
    c.signals = { ...W.witness.signals, ruleBreaks: c.signals.ruleBreaks, corrections: c.signals.corrections, stallTurns: c.signals.stallTurns, canary: c.signals.canary, judge: c.signals.judge }
    c.lastActivityAt = now
    if (progress) c.lastProgressAt = now
  })

  if (moved.length > 0 && moved.some(m => m === 'repeats' || m === 'pingPong' || m === 'sameErrorFixes')) {
    await logEvent($, 'witness', `${moved.join(', ')} on ${tool} ${short(key, 80)}`)
  }

  if (isEdit && file && !isError) await onEdit($, file, now)

  if (tool === 'Bash') {
    if (isError) {
      W.bashFails = W.bashFails.cmd === command ? { cmd: command, count: W.bashFails.count + 1 } : { cmd: command, count: 1 }
      if (W.bashFails.count === 3) await addNeed($, 'stuck', `the same command failed 3× in a row: ${short(command, 120)}`, { risk: 3 })
      if (isTest) await logEvent($, 'fail', `${short(command, 80)} → ${short(errorText.split('\n').find(l => /error|fail/i.test(l)) ?? errorText, 140)}`)
    } else {
      W.bashFails = { cmd: '', count: 0 }
      if (isTest) await logEvent($, 'test', `passed: ${short(command, 100)}`)
    }
    if (git.commit) await logEvent($, 'commit', `${git.commit.sha.slice(0, 7)} ${short(command.match(/-m\s+["']([^"']+)/)?.[1] ?? '', 100)}`)
    const url = git.pr?.url ?? (command.includes('gh pr create') ? str(result.stdout).match(PR_URL)?.[0] : undefined)
    if (url && (git.pr?.action ?? 'created') === 'created') await onPrOpened($, url, now)
  }
}

async function onEdit($: $T, file: string, now: number): Promise<void> {
  const c = W.card
  if (!c) return
  const info = await gitInfo($, dirOf(file))
  if (info) {
    const rel = relTo(info.root, file)
    await touch($, card => {
      const at = card.repos.findIndex(r => r.root === info.root)
      const prev = at >= 0 ? card.repos[at] : { root: info.root, repo: info.repo, branch: info.branch, at: now, files: [] as string[] }
      const next = { ...prev, branch: info.branch, at: now, files: [rel, ...prev.files.filter(f => f !== rel)].slice(0, 40) }
      card.repos = [next, ...card.repos.filter(r => r.root !== info.root)].slice(0, 6)
      if (!card.branch) card.branch = info.branch
    })
    if ((c.area.length || c.doNotTouch.length) && breaksRules(rel, c.area, c.doNotTouch)) {
      await touch($, card => { card.signals.ruleBreaks++ })
      await logEvent($, 'rule', `edited ${rel} outside its area`)
      $.ui.toast(`Kreative Krew: ${rel} is outside your area`)
    }
    const last = W.loggedEdit.get(rel) ?? 0
    if (now - last > 120_000) {
      W.loggedEdit.set(rel, now)
      await logEvent($, 'edit', rel)
    }
    await collisionCheck($, info.root, info.common, info.branch, rel, now)
  }
  await flushCard($)
}

/** Heads-up when another live agent edited the same checkout or branch recently. */
async function collisionCheck($: $T, root: string, common: string, branch: string, rel: string, now: number): Promise<void> {
  const last = W.lastCollisionCheck.get(rel) ?? 0
  if (now - last < 10 * 60_000) return
  W.lastCollisionCheck.set(rel, now)
  const me = W.card
  if (!me) return
  const others = (await readCards($)).filter(c => c.sid !== me.sid && !isDemo(c.sid) && now - c.heartbeatAt < 3 * 60_000)
  for (const o of others) {
    const hit = o.repos.find(r => now - r.at < 30 * 60_000 && (r.root === root || (r.root.startsWith(common) && r.branch === branch && branch !== 'main' && branch !== 'master')))
    if (!hit) continue
    const sameFile = hit.files.includes(rel)
    const text = `[Kreative Krew] Heads-up from ${me.name}: I am editing ${rel} in ${hit.root === root ? 'the same checkout' : `branch ${branch}`} you touched recently${sameFile ? ' (same file)' : ''}. Coordinate before editing it further.`
    try {
      await $.session.send({ to: { sessionId: o.sid }, text })
    } catch {
      // the peer may refuse inbound messages; the radar still shows the overlap
    }
    $.ui.toast(`Collision: ${o.name} also works in ${hit.root === root ? 'this checkout' : branch}`)
    await logEvent($, 'collision', `with ${o.name} on ${rel}`)
  }
}

const VERIFY_PROMPTS = {
  reviewer: (url: string, goal: string) => `Review pull request ${url} with fresh eyes. Run \`gh pr diff ${url}\` and read only what you need.\nThe goal it claims to meet: ${goal || '(see the PR description)'}\nList real bugs, risky changes and missing tests, most severe first, max 6, one line each.\nEnd with a final line exactly: VERDICT: PASS or VERDICT: FAIL`,
  tests: (url: string, goal: string) => `You are an independent test writer. Do NOT read the implementation in ${url} beyond its public interface.\nFrom the goal and acceptance criteria alone write the smallest set of tests that would prove it: ${goal || '(see the PR description: gh pr view ' + url + ')'}\nCheck the PR branch out in a scratch git worktree under the project's tmp/ folder, add the tests there, run them, and remove the worktree.\nReport which pass and fail, one line each. End with a final line exactly: VERDICT: PASS or VERDICT: FAIL`,
  goal: (url: string, goal: string) => `Check pull request ${url} against its ORIGINAL goal, not against what the code happens to do.\nGoal: ${goal || '(see the PR description)'}\nRun \`gh pr view ${url}\` and \`gh pr diff ${url}\`. Is every part of the goal met? Is anything out of scope?\nAnswer in max 5 lines. End with a final line exactly: VERDICT: PASS or VERDICT: FAIL`,
}

async function onPrOpened($: $T, url: string, now: number): Promise<void> {
  const c = W.card
  if (!c || c.prs.some(p => p.url === url)) return
  await touch($, card => {
    card.prs = [{ url, at: now, ci: 'pending' as const, evidence: { verdict: 'pending' as const } }, ...card.prs].slice(0, 8)
    card.lastProgressAt = now
  }, true)
  await addNeed($, 'pr', 'PR opened: verification running, then review/merge', { url, risk: 1 })
  await logEvent($, 'pr', url)
  for (const kind of ['reviewer', 'tests', 'goal'] as const) {
    const agent = kind === 'reviewer' ? 'reviewer' : kind === 'tests' ? 'test-writer' : 'goal-checker'
    try {
      const r = await $.agent.spawn({ subagentType: `kreative-krew:${agent}`, prompt: VERIFY_PROMPTS[kind](url, c.goal ?? ''), description: `krew ${agent}` })
      if (r.agentId) W.pendingVerify.set(r.agentId, { url, kind })
    } catch {
      // verification is best effort; the PR still reaches the inbox
    }
  }
}

async function onAgentAnswer($: $T, agentId: string, answer: string): Promise<void> {
  const job = W.pendingVerify.get(agentId)
  if (!job) return
  W.pendingVerify.delete(agentId)
  const verdict = /VERDICT:\s*PASS/i.test(answer) ? 'PASS' : /VERDICT:\s*FAIL/i.test(answer) ? 'FAIL' : '?'
  const line = `${verdict} · ${short(stripMarkup(answer.replace(/VERDICT:.*$/im, '')), 160)}`
  await touch($, c => {
    c.prs = c.prs.map(p => {
      if (p.url !== job.url) return p
      const ev = { ...(p.evidence ?? { verdict: 'pending' as const }) }
      if (job.kind === 'reviewer') ev.reviewer = line
      if (job.kind === 'tests') ev.tests = line
      if (job.kind === 'goal') ev.goal = line
      const parts = [ev.reviewer, ev.tests, ev.goal]
      ev.verdict = parts.some(x => x?.startsWith('FAIL')) ? 'fail' : parts.every(x => x?.startsWith('PASS')) ? 'pass' : 'pending'
      return { ...p, evidence: ev }
    })
  }, true)
  await logEvent($, 'verify', `${job.kind}: ${verdict} on ${job.url}`)
}

/** session.receive: Manager controls. Returns the text to queue, or null to consume. */
export async function onReceive($: $T, text: string): Promise<string | null> {
  const ctl = decodeCtl(text)
  if (!ctl) {
    if (!parseTag(text)) return text
    const r = await onPromptSubmit($, text, false)
    return [r.context.join('\n\n'), r.text].filter(Boolean).join('\n\n')
  }
  const lead = await readLead($)
  if (!lead || !lead.token || !ctl.token || ctl.token !== lead.token) return null
  const c = W.card
  if (!c || runtime.role !== 'worker') return null
  switch (ctl.op) {
    case 'freeze':
      W.freezeSwap = ctl.swapId
      await touch($, card => { card.state = 'frozen' }, true)
      await logEvent($, 'swap', `frozen for rotation: ${ctl.reason}`)
      return `[Kreative Krew] ROTATION. Reason: ${ctl.reason}.\nA fresh successor will take over your task with a handoff packet. Do this now and nothing else:\n1. Finish or stop the current step; do not start new work.\n2. Commit work in progress on your branch with the message "krew: WIP handoff" (skip if nothing changed). Do not push to main.\n3. Call krew_handoff with: done (claimed finished items), decisions (with why), dead_ends (approaches that failed and why), gotchas, next_steps, open_questions. Copy error messages verbatim.\n4. Then stop and wait. Your successor may ask you questions; answer them briefly with SendMessage.`
    case 'retire':
      await touch($, card => { card.retiringAt = Date.now(); card.state = 'retiring' }, true)
      if (ctl.force) {
        await $.store.set(KEY.retired(c.sid), { name: c.name, report: 'force-retired', at: Date.now() })
        await touch($, card => { card.retiredReport = 'force-retired' }, true)
        return null
      }
      return `[Kreative Krew] RETIRE. You are being retired. Do this now:\n1. Save durable learnings to your memory (update existing entries, do not duplicate).\n2. Post anything teammates must know with krew_note.\n3. Remove ONLY git worktrees you created yourself under <project root>/tmp/ (never force-remove a dirty one: report it as kept). Do not touch any memory directory.\n4. Call krew_retire_ready with a one-paragraph summary, worktrees_removed and kept.`
    case 'compact': {
      const focus = ctl.focus ?? 'Keep the goal, plan, decisions with reasons, dead ends and open questions verbatim.'
      // Busy: the turn's end runs it. Idle: run now; compactSelf re-queues it when the compaction fails.
      W.pendingCompact = c.state === 'busy' ? focus : ''
      if (c.state !== 'busy') void compactSelf($, focus).catch(() => undefined)
      return null
    }
    case 'canary':
      void runCanary($).catch(() => undefined)
      return null
    case 'judge':
      void runJudge($).catch(() => undefined)
      return null
    case 'heads-up':
      return `[Kreative Krew] Heads-up from the Manager: ${ctl.text}`
    case 'warm-ack':
      return null
  }
  return null
}

async function runCanary($: $T): Promise<void> {
  const c = W.card
  if (!c || !cfg.canary) return
  const fork = await $.model.fork({ prompt: 'Without using tools, answer in JSON only: {"goal":"what you are trying to achieve","constraints":["rules you must follow"],"done":["what is finished"],"next":"your next step"}' })
  if (!fork.isAnswered) return
  const grade = await askJson<{ score?: number; why?: string }>(
    $,
    cfg.fastModel,
    'You grade whether an AI agent still knows its task. Compare its answer with the ground truth. Score 0..1: 1 = goal and constraints right, 0 = lost. JSON {"score":0.8,"why":"one line"}',
    `GROUND TRUTH goal: ${c.goal || c.task}\nArea: ${c.area.join(', ') || '—'}; do-not-touch: ${c.doNotTouch.join(', ') || '—'}\nRecent events: ${W.recentTurns.map(t => t.prompt).join(' | ')}\n\nAGENT ANSWER:\n${fork.text}`,
    200,
  )
  if (!grade || typeof grade.score !== 'number') return
  const score = Math.max(0, Math.min(1, grade.score))
  await touch($, card => { card.signals.canary = score }, true)
  await logEvent($, 'canary', `${Math.round(score * 100)}% · ${short(grade.why, 140)}`)
}

async function runJudge($: $T): Promise<void> {
  const c = W.card
  if (!c || W.recentTurns.length === 0) return
  const turns = W.recentTurns.map((t, i) => `TURN ${i + 1}\nUSER: ${t.prompt}\nAGENT: ${t.answer}`).join('\n\n')
  const r = await askJson<{ score?: number; issues?: unknown }>(
    $,
    cfg.smartModel,
    'You are a fresh-eyes judge of an AI coding agent\'s recent work. Score 0..1 how well it is still doing: on-task, consistent, following rules, making progress, not repeating itself. JSON {"score":0.7,"issues":["one line each"]}',
    `GOAL: ${c.goal || c.task}\nRULES: area ${c.area.join(', ') || '—'}; never touch ${c.doNotTouch.join(', ') || '—'}\nSIGNALS: ${JSON.stringify(c.signals)}\n\n${turns}`,
    400,
  )
  if (!r || typeof r.score !== 'number') return
  const score = Math.max(0, Math.min(1, r.score))
  await touch($, card => { card.signals.judge = score }, true)
  await logEvent($, 'judge', `${Math.round(score * 100)}% · ${strings(r.issues, 2, 100).join('; ')}`)
}

export async function handoffFactsFor($: $T, c: Card): Promise<HandoffFacts> {
  const cwd = c.worktree || c.cwd
  const status = await run($, ['git', 'status', '--porcelain'], cwd, 8000)
  const head = await run($, ['git', 'log', '-1', '--format=%h %s'], cwd, 8000)
  const branch = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd, 8000)
  const files = c.repos.flatMap(r => r.files.map(f => `${r.root}/${f}`)).slice(0, 15)
  const exists = await Promise.all(files.map(f => $.fs.exists(f).catch(() => false)))
  const events = (((await $.store.get(KEY.log(c.sid))) as { kind: string; text: string }[] | undefined) ?? []).slice(-60)
  return {
    cwd,
    branch: branch.ok ? branch.out.trim() : c.branch,
    head: head.ok ? head.out.trim() : undefined,
    dirty: status.ok ? status.out.trim().split('\n').filter(Boolean).map(l => l.slice(3)).slice(0, 30) : [],
    lastTest: events.filter(e => e.kind === 'test' || e.kind === 'fail').pop()?.text,
    failures: events.filter(e => e.kind === 'fail').slice(-5).map(e => e.text),
    keyFiles: files.filter((_, i) => exists[i]).map(f => relTo(cwd, f)),
    prs: c.prs.map(p => `${p.url} (${p.ci ?? '?'})`),
    costUsd: c.costUsd,
    contextPercent: c.contextPercent,
  }
}

const SCHEMA_LIST = { type: 'array', items: { type: 'string' } }

export async function registerWorkerTools($: $T): Promise<void> {
  await $.tool.register({
    name: 'krew_board',
    description: 'Kreative Krew: see your teammates (name, state, task, area, repo@branch), open conflicts and recent team notes. Call before starting new work.',
    inputSchema: { type: 'object', properties: {} },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'krew_note',
    description: 'Kreative Krew: post a short durable learning or a failed approach for the whole team.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'ask_manager',
    description: 'Kreative Krew: flag something for the human manager (a question, a choice of approaches, a PR to review, or a blocker). Batch approach choices into one call with options.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        kind: { type: 'string', enum: ['question', 'approach', 'pr', 'blocked'] },
        url: { type: 'string' },
        options: SCHEMA_LIST,
      },
      required: ['text', 'kind'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'krew_handoff',
    description: 'Kreative Krew: during a ROTATION only, hand your task to your successor. Copy errors verbatim.',
    inputSchema: {
      type: 'object',
      properties: { done: SCHEMA_LIST, decisions: SCHEMA_LIST, dead_ends: SCHEMA_LIST, gotchas: SCHEMA_LIST, next_steps: SCHEMA_LIST, open_questions: SCHEMA_LIST },
    },
  })
  await $.tool.register({
    name: 'krew_warmup_done',
    description: 'Kreative Krew: as a successor, report that you verified the handoff (what you verified, any discrepancies).',
    inputSchema: { type: 'object', properties: { summary: { type: 'string' }, verified: SCHEMA_LIST, discrepancies: SCHEMA_LIST }, required: ['summary'] },
  })
  await $.tool.register({
    name: 'ask_predecessor',
    description: 'Kreative Krew: as a successor, ask the session you replaced a question it can answer from its own history.',
    inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
  })
  await $.tool.register({
    name: 'krew_retire_ready',
    description: 'Kreative Krew: after a RETIRE brief only, report that you are ready to be shut down.',
    inputSchema: {
      type: 'object',
      properties: { summary: { type: 'string' }, worktrees_removed: SCHEMA_LIST, kept: SCHEMA_LIST },
      required: ['summary'],
    },
  })
  await registerAgentTypes($)
}

async function registerAgentTypes($: $T): Promise<void> {
  const common = { tools: ['Read', 'Grep', 'Glob', 'Bash'], model: 'sonnet', omitClaudeMd: true as const }
  try {
    await $.agent.register({ name: 'reviewer', description: 'Kreative Krew fresh-context PR reviewer: reads only the diff and reports real bugs.', prompt: 'You are a strict, fair code reviewer with no prior context. Report only real problems. End with VERDICT: PASS or VERDICT: FAIL.', ...common })
    await $.agent.register({ name: 'test-writer', description: 'Kreative Krew independent test writer: writes tests from the spec without reading the implementation.', prompt: 'You write tests from a specification only. You never read the implementation beyond its public interface. End with VERDICT: PASS or VERDICT: FAIL.', ...common, tools: ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit'] })
    await $.agent.register({ name: 'goal-checker', description: 'Kreative Krew goal checker: verifies a PR against its original goal.', prompt: 'You check work against its original goal and scope. End with VERDICT: PASS or VERDICT: FAIL.', ...common })
  } catch {
    // agent types are optional; the triad is skipped where they cannot register
  }
}

type ToolAnswer = { result: string } | { isError: true; result: string }

export async function boardText($: $T): Promise<string> {
  const now = await $.clock.now()
  const cards = (await readCards($)).filter(c => now - c.heartbeatAt < 3 * 60_000)
  const notes = (await readNotes($)).slice(-6)
  const lines = cards.map(c => {
    const repo = c.repos[0]
    return `- ${c.name}${c.gen > 1 ? ` (gen ${c.gen})` : ''} [${c.state}] ${c.task || 'no task'} · area ${c.area.join(', ') || '—'} · ${repo ? `${repo.repo}@${repo.branch}` : '—'}${repo?.files.length ? ` · recent: ${repo.files.slice(0, 4).join(', ')}` : ''}`
  })
  return [
    `Kreative Krew board (${cards.length} live)`,
    ...(lines.length ? lines : ['- nobody else is live']),
    '',
    'Recent notes:',
    ...(notes.length ? notes.map(n => `- ${n.name}: ${n.text}`) : ['- none']),
  ].join('\n')
}

export async function answerWorkerTool($: $T, name: string, input: Loose): Promise<ToolAnswer> {
  const c = W.card
  const now = await $.clock.now()
  if (name === 'krew_board') return { result: await boardText($) }
  if (runtime.role === 'none') return { isError: true, result: 'This session is not part of a crew: no Manager runs for this project, or it was not hired.' }
  switch (name) {
    case 'krew_note': {
      const text = short(str(input.text), 400)
      if (!text) return { isError: true, result: 'text is required' }
      const me = c && runtime.role === 'worker' ? c : { sid: runtime.sid, name: 'Manager' }
      await appendNote($, { at: now, sid: me.sid, name: me.name, text })
      await logEvent($, 'note', text)
      return { result: 'Posted to the team.' }
    }
    case 'ask_manager': {
      if (!c) return { isError: true, result: 'no crew card yet' }
      const kind = (['question', 'approach', 'pr', 'blocked'] as const).find(k => k === input.kind) ?? 'question'
      await addNeed($, kind, str(input.text), { url: str(input.url) || undefined, options: strings(input.options, 5, 80), risk: kind === 'blocked' ? 3 : 1 })
      return { result: 'Flagged for the human. Continue with anything that does not depend on the answer; the reply arrives as a message.' }
    }
    case 'krew_handoff': {
      if (!c || !W.freezeSwap) return { isError: true, result: 'There is no rotation in progress. Only call this after a ROTATION message.' }
      const account: HandoffAccount = {
        done: strings(input.done, 15),
        decisions: strings(input.decisions, 15),
        deadEnds: strings(input.dead_ends, 15),
        gotchas: strings(input.gotchas, 10),
        nextSteps: strings(input.next_steps, 10),
        openQuestions: strings(input.open_questions, 10),
      }
      const facts = await handoffFactsFor($, c)
      await $.store.set(KEY.handoff(W.freezeSwap), { raw: true, sid: c.sid, name: c.name, goal: c.goal ?? c.task, briefId: c.briefId, facts, account, at: now })
      await touch($, card => { card.handoffReady = W.freezeSwap }, true)
      await logEvent($, 'swap', 'handoff saved')
      return { result: 'Handoff saved. Stop now and wait; answer your successor briefly if it asks.' }
    }
    case 'krew_warmup_done': {
      if (!c) return { isError: true, result: 'no crew card yet' }
      await touch($, card => { card.warm = true }, true)
      const disc = strings(input.discrepancies, 8)
      await logEvent($, 'swap', `warm-up done: ${short(str(input.summary), 160)}${disc.length ? ` · ${disc.length} discrepancies` : ''}`)
      if (disc.length) await addNeed($, 'question', `handoff discrepancies: ${disc.join('; ')}`, { risk: 2 })
      return { result: 'Thanks. The Manager will retire your predecessor. Carry on with the plan.' }
    }
    case 'ask_predecessor': {
      if (!c?.predecessor) return { isError: true, result: 'You have no predecessor.' }
      const q = short(str(input.question), 800)
      try {
        const sent = await $.session.send({ to: { sessionId: c.predecessor }, text: `[Kreative Krew] Your successor ${c.name} asks: ${q}\nAnswer briefly from your own history with SendMessage to session ${c.sid}.` })
        return sent.isDelivered ? { result: 'Asked. The answer arrives as a message.' } : { isError: true, result: `Not delivered: ${sent.reason}. Search the handoff packet instead.` }
      } catch (error) {
        return { isError: true, result: `Could not reach the predecessor: ${String(error)}` }
      }
    }
    case 'krew_retire_ready': {
      if (!c?.retiringAt) return { isError: true, result: 'You are not being retired. Only call this after a RETIRE message.' }
      const report = [short(str(input.summary), 600), strings(input.kept).length ? `kept: ${strings(input.kept).join(', ')}` : ''].filter(Boolean).join(' · ')
      await $.store.set(KEY.retired(c.sid), { name: c.name, report, at: now })
      await touch($, card => { card.retiredReport = report; card.state = 'retiring' }, true)
      await logEvent($, 'retire', report)
      return { result: 'Retired. The Manager will close this session; stop here.' }
    }
  }
  return { isError: true, result: `unknown krew tool ${name}` }
}

export function registerWorker(on: On): void {
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) await onTurnStart($, e.text).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    void onTurnComplete($, e.answer, e.agentId).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    await onMeasure($, e.context.percent, e.cost?.usd).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!('skip' in r && r.skip)) void onCompacted($).catch(() => undefined)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.Notification', async ($, e, next) => {
    await onNotification($, e.notification_type, e.message).catch(() => undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    const text = await onReceive($, e.text).catch(() => e.text)
    if (text === null) return { consumed: 'kreative-krew control message' }
    return text === e.text ? next(e) : next({ ...e, text })
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    await observeTool($, e as unknown as Loose, ran).catch(() => undefined)
    return ran
  }).catch(($, e, next) => next(e))
}
