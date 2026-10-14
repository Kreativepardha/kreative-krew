// Demo mode: a realistic fake crew in the shared store, so the dashboard can be
// explored (and recorded) without hiring real workers. Demo cards carry a
// `demo-` session id and are never messaged or torn down.

import type { EngineInterface } from 'claude-code'

import type { Brief, Card, KEvent, LeadState, Note, Swap } from '../../types'
import { KEY, readLeadState, writeLeadState } from './io'
import { emptyCard } from './util'

type $T = EngineInterface

export const DEMO_PREFIX = 'demo-'

export function isDemo(sid: string): boolean {
  return sid.startsWith(DEMO_PREFIX)
}

function card(now: number, over: Partial<Card> & { sid: string; name: string }): Card {
  return { ...emptyCard(over.sid, over.name, now - 40 * 60_000, '/work/app'), heartbeatAt: now, lastActivityAt: now - 90_000, lastProgressAt: now - 3 * 60_000, ...over }
}

export function demoCards(now: number): Card[] {
  const minutes = (m: number) => now - m * 60_000
  return [
    card(now, {
      sid: `${DEMO_PREFIX}atlas`, name: 'Atlas', gen: 2, lineage: ['Atlas'], state: 'busy', task: 'login rate limiting',
      bullets: ['Added a per-IP sliding window', 'Returns 429 with Retry-After', 'Writing the integration test'],
      repos: [{ root: '/work/app', repo: 'kreative/app', branch: 'krew/atlas', at: minutes(2), files: ['src/auth/limiter.ts', 'src/auth/login.ts', 'test/auth/limiter.test.ts'] }],
      contextPercent: 61, costUsd: 2.4, budgetUsd: 5, sharpness: 82, mood: 'focused', area: ['src/auth/**', 'test/auth/**'], doNotTouch: ['migrations/**'], branch: 'krew/atlas', worktree: '/work/app/tmp/krew-atlas', portBase: 4100, turns: 14, goal: 'Stop brute force on /login',
      signals: { toolCalls: 88, toolErrors: 6, repeats: 0, pingPong: 0, rereads: 1, sameErrorFixes: 0, churn: 0, ruleBreaks: 0, invented: 0, redoAfterCompact: 0, corrections: 0, stallTurns: 0, compactions: 1 },
    }),
    card(now, {
      sid: `${DEMO_PREFIX}nova`, name: 'Nova', state: 'waiting', task: 'billing webhook retries',
      bullets: ['Stripe webhooks now idempotent', 'PR open, CI green', 'Waiting for a decision on retry policy'],
      needs: [{ id: 'demo-n1', kind: 'approach', text: 'Retry failed webhooks with exponential backoff, or queue them for a worker?', options: ['backoff', 'queue'], risk: 1, at: minutes(6), draft: 'Queue them: keep the idempotency key and let the worker retry. Backoff inside the request would hold the HTTP connection.' }],
      prs: [{ url: 'https://github.com/kreative/app/pull/412', title: 'Idempotent Stripe webhooks', state: 'OPEN', ci: 'pass', at: minutes(25), evidence: { reviewer: 'PASS · no issues beyond a missing log line', tests: 'PASS · 6/6 spec-derived tests pass', goal: 'PASS · goal met, nothing out of scope', verdict: 'pass' } }],
      repos: [{ root: '/work/app', repo: 'kreative/app', branch: 'krew/nova', at: minutes(9), files: ['src/billing/webhooks.ts', 'src/auth/login.ts'] }],
      contextPercent: 44, costUsd: 3.1, budgetUsd: 6, sharpness: 91, mood: '+shipped', area: ['src/billing/**'], branch: 'krew/nova', worktree: '/work/app/tmp/krew-nova', portBase: 4110, turns: 11, goal: 'Make Stripe webhook handling idempotent and retried',
    }),
    card(now, {
      sid: `${DEMO_PREFIX}rex`, name: 'Rex', state: 'busy', task: 'flaky search tests',
      bullets: ['Reproduced the flake locally', 'Same assertion keeps failing after 3 fixes'],
      repos: [{ root: '/work/app', repo: 'kreative/app', branch: 'krew/rex', at: minutes(1), files: ['src/search/index.ts', 'test/search/index.test.ts'] }],
      contextPercent: 87, costUsd: 4.9, budgetUsd: 4, sharpness: 31, hard: ['same error after 4 fix attempts', 'context 87%'], mood: 'exhausted', area: ['src/search/**', 'test/search/**'], branch: 'krew/rex', worktree: '/work/app/tmp/krew-rex', portBase: 4120, turns: 23, goal: 'Make the search test suite deterministic',
      signals: { toolCalls: 140, toolErrors: 41, repeats: 3, pingPong: 1, rereads: 2, sameErrorFixes: 3, churn: 1, ruleBreaks: 0, invented: 1, redoAfterCompact: 1, corrections: 1, stallTurns: 4, compactions: 2 },
    }),
    card(now, {
      sid: `${DEMO_PREFIX}juno`, name: 'Juno', state: 'idle', task: 'docs for the public API',
      bullets: ['OpenAPI spec regenerated', 'Examples added for every endpoint'],
      repos: [{ root: '/work/app', repo: 'kreative/app', branch: 'krew/juno', at: minutes(30), files: ['docs/api.md', 'openapi.yaml'] }],
      contextPercent: 23, costUsd: 0.8, budgetUsd: 2, sharpness: 97, mood: 'sharp', area: ['docs/**', 'openapi.yaml'], branch: 'krew/juno', worktree: '/work/app/tmp/krew-juno', portBase: 4130, turns: 6, lastActivityAt: minutes(31),
    }),
  ]
}

export function demoBrief(now: number): Brief {
  return {
    id: 'demo-b1', ask: 'add a dark mode toggle to settings', status: 'pending', title: 'Dark mode toggle in Settings',
    goal: 'Users can switch the app between light and dark themes from Settings, and the choice persists.',
    context: 'Theme tokens already exist in src/theme/tokens.ts; nothing reads a user preference yet.',
    criteria: ['A toggle in Settings switches the theme instantly', 'The choice persists across reloads', 'System preference is the default', 'No contrast regressions on the five main screens'],
    area: ['src/settings/**', 'src/theme/**'], doNotTouch: ['src/auth/**', 'src/billing/**', 'package-lock.json'],
    verify: ['npm test', 'Manual: toggle, reload, theme sticks', 'npm run lint'],
    deadEnds: ['CSS prefers-color-scheme alone was tried last sprint: it cannot be overridden by a user choice'],
    outputFormat: 'PR link, 3-line summary, screenshots of both themes', budgetUsd: 4, assignees: [], hireName: 'Pixel', createdAt: now - 20_000, revisions: 0,
  }
}

export function demoSwap(now: number): Swap {
  return { id: 'demo-s1', fromSid: `${DEMO_PREFIX}rex`, fromName: 'Rex', toName: 'Rex II', gen: 2, reason: 'same error after 4 fix attempts; context 87%', mode: 'emergency', status: 'proposed', at: now - 60_000, updatedAt: now - 60_000 }
}

export function demoNotes(now: number): Note[] {
  return [
    { at: now - 50 * 60_000, sid: `${DEMO_PREFIX}nova`, name: 'Nova', text: 'The Stripe test mode replays webhooks out of order: never assume event order.' },
    { at: now - 35 * 60_000, sid: `${DEMO_PREFIX}atlas`, name: 'Atlas', text: 'Dead end: rate limiting in middleware broke the health check; do it in the login handler.' },
    { at: now - 12 * 60_000, sid: `${DEMO_PREFIX}juno`, name: 'Juno', text: 'openapi.yaml is generated: edit the JSDoc, not the file.' },
  ]
}

export function demoEvents(now: number): KEvent[] {
  const m = (min: number) => now - min * 60_000
  return [
    { at: m(55), sid: `${DEMO_PREFIX}atlas`, name: 'Atlas', kind: 'hired', text: 'Atlas II started from a handoff' },
    { at: m(48), sid: `${DEMO_PREFIX}nova`, name: 'Nova', kind: 'edit', text: 'src/billing/webhooks.ts' },
    { at: m(40), sid: `${DEMO_PREFIX}rex`, name: 'Rex', kind: 'fail', text: 'npm test → expected 3 results, got 2' },
    { at: m(33), sid: `${DEMO_PREFIX}rex`, name: 'Rex', kind: 'witness', text: 'sameErrorFixes on Bash npm test' },
    { at: m(25), sid: `${DEMO_PREFIX}nova`, name: 'Nova', kind: 'pr', text: 'https://github.com/kreative/app/pull/412' },
    { at: m(22), sid: `${DEMO_PREFIX}nova`, name: 'Nova', kind: 'verify', text: 'reviewer: PASS on https://github.com/kreative/app/pull/412' },
    { at: m(18), sid: `${DEMO_PREFIX}rex`, name: 'Rex', kind: 'compact', text: 'context compacted' },
    { at: m(14), sid: `${DEMO_PREFIX}rex`, name: 'Rex', kind: 'witness', text: 'redoAfterCompact on Edit src/search/index.ts' },
    { at: m(9), sid: `${DEMO_PREFIX}atlas`, name: 'Atlas', kind: 'collision', text: 'with Nova on src/auth/login.ts' },
    { at: m(6), sid: `${DEMO_PREFIX}nova`, name: 'Nova', kind: 'need', text: 'approach: retry failed webhooks with backoff, or queue?' },
    { at: m(2), sid: `${DEMO_PREFIX}atlas`, name: 'Atlas', kind: 'test', text: 'passed: npm test -- auth' },
  ]
}

export async function seedDemo($: $T): Promise<string> {
  const now = await $.clock.now()
  for (const c of demoCards(now)) await $.store.set(KEY.card(c.sid), c)
  await $.store.set(KEY.notes(`${DEMO_PREFIX}notes`), demoNotes(now))
  await $.store.set(KEY.log(`${DEMO_PREFIX}log`), demoEvents(now))
  const s: LeadState = await readLeadState($)
  s.briefs = [...s.briefs.filter(b => b.id !== 'demo-b1'), demoBrief(now)]
  s.swaps = [...s.swaps.filter(x => x.id !== 'demo-s1'), demoSwap(now)]
  s.merged = [...s.merged.filter(m => !m.url.includes('kreative/app')), { url: 'https://github.com/kreative/app/pull/398', at: now - 3 * 3_600_000, owner: 'Juno', costUsd: 1.9 }, { url: 'https://github.com/kreative/app/pull/401', at: now - 2 * 3_600_000, owner: 'Atlas', costUsd: 3.2 }]
  s.queue = [...s.queue.filter(q => !q.url.includes('kreative/app')), { url: 'https://github.com/kreative/app/pull/409', owner: 'Nova', status: 'checking', at: now - 10 * 60_000, note: 'rebased on main, CI rerunning' }]
  s.dismissed = s.dismissed.filter(d => !d.includes('demo'))
  await writeLeadState($, s)
  await $.store.set('krew:demo', { at: now })
  return 'Demo crew seeded: Atlas, Nova, Rex and Juno are live in the dashboard (nothing real runs). /krew-demo off removes them.'
}

export async function demoHire($: $T, name: string, b: Brief): Promise<void> {
  const now = await $.clock.now()
  const c = card(now, { sid: `${DEMO_PREFIX}${name.toLowerCase()}`, name, state: 'busy', task: b.title.toLowerCase(), bullets: ['Read the brief', 'Set up its worktree and ports'], area: b.area, doNotTouch: b.doNotTouch, budgetUsd: b.budgetUsd, goal: b.goal, briefId: b.id, contextPercent: 3, costUsd: 0.05, sharpness: 100, mood: 'fresh', branch: `krew/${name.toLowerCase()}`, worktree: `/work/app/tmp/krew-${name.toLowerCase()}`, portBase: 4140, turns: 1, lastActivityAt: now, lastProgressAt: now, repos: [] })
  await $.store.set(KEY.card(c.sid), c)
}

export async function clearDemo($: $T): Promise<string> {
  for (const k of await $.store.keys()) if (k.startsWith(`krew:card:${DEMO_PREFIX}`) || k.startsWith(`krew:notes:${DEMO_PREFIX}`) || k.startsWith(`krew:log:${DEMO_PREFIX}`)) await $.store.delete(k)
  const s = await readLeadState($)
  s.briefs = s.briefs.filter(b => !b.id.startsWith('demo-'))
  s.swaps = s.swaps.filter(x => !x.id.startsWith('demo-'))
  s.merged = s.merged.filter(m => !m.url.includes('kreative/app'))
  s.queue = s.queue.filter(q => !q.url.includes('kreative/app'))
  await writeLeadState($, s)
  await $.store.delete('krew:demo')
  return 'Demo crew removed.'
}

/** Keeps demo cards live and their clocks moving between polls. */
export async function tickDemo($: $T, cards: Card[], now: number, keys?: string[]): Promise<Card[]> {
  if (!(keys ? keys.includes('krew:demo') : await $.store.get('krew:demo'))) return cards
  return cards.map(c => (isDemo(c.sid) ? { ...c, heartbeatAt: now, lastActivityAt: c.state === 'idle' ? c.lastActivityAt : now - 90_000, costUsd: c.costUsd + (c.state === 'busy' ? 0.004 : 0) } : c))
}
