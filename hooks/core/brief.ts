// The brief compiler: a rough ask becomes a structured, approvable brief.

import type { EngineInterface } from 'claude-code'

import type { Brief, Card, Note } from '../../types'
import { askJson, cfg } from './io'
import { num, short, str, strings, uid } from './util'

type $T = EngineInterface

export const BRIEF_SYSTEM = `You are the Manager of a crew of AI coding agents (Claude Code sessions).
Turn the human's rough ask into a precise work brief for ONE coding agent that starts with no context.
Rules:
- Goal: one sentence, outcome-focused.
- Context: only what the agent cannot discover quickly itself; no guessing about code you have not seen.
- Acceptance criteria: 3-6 checkable statements.
- Area: repo-relative globs the agent owns (may write). Leave empty when unknown.
- Do-not-touch: globs other agents own or that are risky (lockfiles, migrations, CI) when relevant.
- Verify: concrete steps (commands or checks) proving the criteria.
- Dead ends: copy relevant failed approaches from team notes; never invent any.
- Output format: what the agent must report when done (PR link, summary, open questions).
- Budget in USD: small fix 1-3, feature 3-8, large 8-15.
- Assignee: pick idle agents whose recent work overlaps the area; else propose a short, memorable one-word hire name.
- Keep each list item under 25 words. No code.
JSON shape: {"title":"","goal":"","context":"","criteria":[],"area":[],"doNotTouch":[],"verify":[],"deadEnds":[],"outputFormat":"","budgetUsd":3,"assignees":[],"hireName":""}`

export function teamContext(agents: Card[], notes: Note[]): string {
  const team = agents
    .map(a => `- ${a.name} [${a.state}] task: ${a.task || 'none'}; area: ${a.area.join(', ') || '—'}; repo: ${a.repos[0]?.repo ?? '—'}@${a.branch ?? a.repos[0]?.branch ?? '—'}`)
    .join('\n')
  const recent = notes
    .slice(-8)
    .map(n => `- ${n.name}: ${short(n.text, 200)}`)
    .join('\n')
  return `Team:\n${team || '- (no workers yet)'}\n\nRecent team notes and dead ends:\n${recent || '- (none)'}`
}

export function draftBrief(ask: string, now: number): Brief {
  return {
    id: uid('b'),
    ask,
    status: 'compiling',
    title: short(ask, 60),
    goal: '',
    context: '',
    criteria: [],
    area: [],
    doNotTouch: [],
    verify: [],
    deadEnds: [],
    outputFormat: '',
    budgetUsd: cfg.defaultBudgetUsd,
    assignees: [],
    createdAt: now,
    revisions: 0,
  }
}

type Compiled = {
  title?: string
  goal?: string
  context?: string
  criteria?: unknown
  area?: unknown
  doNotTouch?: unknown
  verify?: unknown
  deadEnds?: unknown
  outputFormat?: string
  budgetUsd?: number
  assignees?: unknown
  hireName?: string
}

export function applyCompiled(b: Brief, c: Compiled, known: string[]): Brief {
  const assignees = strings(c.assignees, 6, 40).filter(n => known.some(k => k.toLowerCase() === n.toLowerCase()))
  const hire = str(c.hireName).replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 20)
  return {
    ...b,
    status: 'pending',
    title: short(str(c.title, b.title), 70),
    goal: short(str(c.goal, b.ask), 300),
    context: short(str(c.context), 900),
    criteria: strings(c.criteria),
    area: strings(c.area, 10, 120),
    doNotTouch: strings(c.doNotTouch, 10, 120),
    verify: strings(c.verify),
    deadEnds: strings(c.deadEnds),
    outputFormat: short(str(c.outputFormat, 'PR link, 3-line summary, open questions'), 300),
    budgetUsd: Math.max(0.5, Math.min(50, num(c.budgetUsd, b.budgetUsd))),
    assignees: b.assignees.length > 0 ? b.assignees : assignees,
    hireName: b.assignees.length > 0 ? undefined : assignees.length > 0 ? undefined : hire || b.hireName || 'Scout',
  }
}

export async function compileBrief($: $T, b: Brief, agents: Card[], notes: Note[], revision?: string): Promise<Brief> {
  const prompt = [
    `Human's ask:\n${b.ask}`,
    revision ? `\nCurrent brief:\n${renderBrief(b)}\n\nHuman's revision request:\n${revision}` : '',
    `\n${teamContext(agents, notes)}`,
    b.assignees.length > 0 ? `\nThe human already chose: ${b.assignees.join(', ')}` : '',
    b.hireName ? `\nThe human wants a new hire named ${b.hireName}` : '',
  ].join('\n')
  const c = await askJson<Compiled>($, cfg.smartModel, BRIEF_SYSTEM, prompt, 1400)
  if (!c) return { ...b, status: 'failed', error: 'the brief model did not answer' }
  const next = applyCompiled(b, c, agents.map(a => a.name))
  return revision ? { ...next, revisions: b.revisions + 1 } : next
}

/** The text a worker receives. */
export function renderBrief(b: Brief): string {
  const list = (title: string, items: string[]) => (items.length ? `\n## ${title}\n${items.map(i => `- ${i}`).join('\n')}` : '')
  return [
    `# Brief ${b.id}: ${b.title}`,
    `\n## Goal\n${b.goal}`,
    b.context ? `\n## Context\n${b.context}` : '',
    list('Acceptance criteria', b.criteria),
    list('You own (may edit)', b.area),
    list('Do NOT touch', b.doNotTouch),
    list('Verify by', b.verify),
    list('Known dead ends (do not retry)', b.deadEnds),
    `\n## When done\n${b.outputFormat}`,
    `\nBudget: about $${b.budgetUsd.toFixed(2)}. Stop and ask_manager before going far over it.`,
  ].join('\n')
}
