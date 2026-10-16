// The brief compiler: a rough ask becomes a structured, approvable brief.

import type { EngineInterface } from 'claude-code'

import type { Brief, Card, Effort, Note } from '../../types'
import { askJson, cfg } from './io'
import { num, short, str, strings, uid } from './util'

type $T = EngineInterface

export const BRIEF_SYSTEM = `You are the Manager of a crew of AI coding agents (Claude Code sessions).
Turn the human's rough ask into a precise work brief for ONE coding agent that starts with no context.
Rules:
- Task: WHAT to build, fix or decide, rewritten from the ask in plain full sentences: fix spelling and grammar, keep every requirement, name, detail and the exact intent, add nothing. Other sections already carry the rest, so drop from the task: the role list ("I am onboarding you as…") which goes to Roles; any "understand/read the code first", "research and plan before acting" lines, which a fixed section covers; and how to deliver the output (artifact, format, language, diagrams), which goes to Kind and Output format.
- Roles: 3-8 expert roles this task needs, each with its article, e.g. "a lead product designer". Keep any roles the human named. UI work: lead product designer, frontend or full-stack developer, product strategist. Backend: CTO, backend or full-stack developer, database/infra engineer, product architecture specialist. Agent or LLM work: AI agent expert, LLM engineer. Add domain experts the task needs (e.g. a threat hunter, a blue-team engineer, a builder of offensive and defensive security tools).
- Kind: "plan" when the deliverable is a plan, design or research (no code ships); else "build".
- Effort: "high" for plan tasks and for first tasks in an unfamiliar area; else "".
- Goal: one sentence, outcome-focused.
- Context: only what the agent cannot discover quickly itself; no guessing about code you have not seen.
- Acceptance criteria: 3-6 checkable statements.
- Area: repo-relative globs the agent owns (may write). Leave empty when unknown.
- Do-not-touch: globs other agents own or that are risky (lockfiles, migrations, CI) when relevant.
- Verify: concrete steps (commands or checks) proving the criteria.
- Dead ends: copy relevant failed approaches from team notes; never invent any.
- Output format: what the agent must report when done (PR link, summary, open questions), plus any output demand from the ask that a plan brief's fixed output (HTML artifact, ASD-STE100, diagrams) does not already cover.
- Budget in USD: small fix 1-3, feature 3-8, large 8-15.
- Assignee: pick idle agents whose recent work overlaps the area; else propose a short, memorable one-word hire name.
- Keep each list item under 25 words. No code.
JSON shape: {"title":"","task":"","roles":[],"kind":"build","effort":"","goal":"","context":"","criteria":[],"area":[],"doNotTouch":[],"verify":[],"deadEnds":[],"outputFormat":"","budgetUsd":3,"assignees":[],"hireName":""}`

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
  task?: string
  roles?: unknown
  kind?: string
  effort?: string
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

const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export function applyCompiled(b: Brief, c: Compiled, known: string[]): Brief {
  const assignees = strings(c.assignees, 6, 40).filter(n => known.some(k => k.toLowerCase() === n.toLowerCase()))
  const hire = str(c.hireName).replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 20)
  // A revision that leaves a field out keeps what the brief had.
  const kind = c.kind === 'plan' || c.kind === 'build' ? c.kind : b.kind ?? 'build'
  const effort = kind === 'plan' ? 'high' : c.effort === undefined ? b.effort : EFFORTS.find(e => e === c.effort)
  const roles = strings(c.roles, 8, 80)
  return {
    ...b,
    status: 'pending',
    title: short(str(c.title, b.title), 70),
    task: short(str(c.task) || b.task || b.ask, 2000),
    roles: roles.length > 0 ? roles : b.roles ?? [],
    kind,
    effort,
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
  const c = await askJson<Compiled>($, cfg.smartModel, BRIEF_SYSTEM, prompt, 2400)
  if (!c) return { ...b, status: 'failed', error: 'the brief model did not answer' }
  const next = applyCompiled(b, c, agents.map(a => a.name))
  return revision ? { ...next, revisions: b.revisions + 1 } : next
}

const UNDERSTAND_FIRST = [
  'Understand the relevant codebase deeply before you change anything.',
  'Read the code, not just the docs: docs drift from the code.',
  'Research and plan: what you read, the options, the approach you pick and why.',
  'Only proceed after the research and the plan are done.',
]

const PLAN_OUTPUT =
  'A Claude HTML artifact with the complete plan: UI to backend, the entire architecture and, where agents are involved, the agent architecture. ' +
  'Write it in ASD-STE100 Simplified Technical English and include diagrams. This task delivers the plan, not the build.'

/** The text a worker receives, and the text the human approves. */
export function renderBrief(b: Brief): string {
  const list = (title: string, items: string[]) => (items.length ? `\n## ${title}\n${items.map(i => `- ${i}`).join('\n')}` : '')
  const roles = b.roles ?? []
  const team = roles.length > 1 ? `${roles.slice(0, -1).join(', ')} and ${roles[roles.length - 1]}` : roles[0]
  return [
    team ? `I am onboarding you as ${team}.\n` : '',
    `# Brief ${b.id}: ${b.title}`,
    `\n## Task\n${b.task || b.ask}`,
    list('Understand first', UNDERSTAND_FIRST),
    `\n## Goal\n${b.goal}`,
    b.context ? `\n## Context\n${b.context}` : '',
    list('Acceptance criteria', b.criteria),
    list('You own (may edit)', b.area),
    list('Do NOT touch', b.doNotTouch),
    list('Verify by', b.verify),
    list('Known dead ends (do not retry)', b.deadEnds),
    b.kind === 'plan' ? `\n## Output\n${PLAN_OUTPUT}` : '',
    `\n## When done\n${b.outputFormat}`,
    `\nBudget: about $${b.budgetUsd.toFixed(2)}. Stop and ask_manager before going far over it.`,
    cfg.standingRules ? `\n## Standing rules\n${cfg.standingRules}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}
