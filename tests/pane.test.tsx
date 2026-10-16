import { expect, mock, test, type Engine } from 'claude-code/testing'

import type { On } from 'claude-code'

import type { Board, Brief } from '../types'

const PANE_PROPS = { title: 'Krew', isFocused: true, bodyColumns: 100, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 30 }, view: {} }

function board(): Board {
  return {
    agents: [
      {
        sid: '11111111-1111-4111-8111-111111111111', name: 'Atlas', gen: 2, lineage: ['Atlas'], state: 'busy', task: 'auth timeout fix',
        bullets: ['found the retry bug'], needs: [], repos: [], prs: [], contextPercent: 62, costUsd: 1.2, budgetUsd: 3,
        sharpness: 34, hard: ['same error after 3 fix attempts'], signals: { toolCalls: 10, toolErrors: 4, repeats: 2, pingPong: 0, rereads: 0, sameErrorFixes: 2, churn: 0, ruleBreaks: 0, invented: 0, redoAfterCompact: 0, corrections: 0, stallTurns: 0, compactions: 1 },
        mood: 'exhausted', area: ['src/auth/**'], doNotTouch: [], cwd: '/r', turns: 9, startedAt: 0, lastActivityAt: 0, heartbeatAt: 0, lastProgressAt: 0,
      },
    ],
    offline: [],
    notes: [{ at: 1, sid: 'x', name: 'Nova', text: 'redis mock lives in test/helpers' }],
    events: [{ at: 1, sid: 'x', name: 'Atlas', kind: 'fail', text: 'npm test → expected 2 got 3' }],
    inbox: [
      { id: 'brief:b1', kind: 'brief', text: 'Rate-limit login', risk: 2, at: 1, ref: 'b1', name: 'Atlas' },
      { id: 'q1', kind: 'approach', text: 'retry or queue?', risk: 1, at: 2, sid: '11111111-1111-4111-8111-111111111111', name: 'Atlas', options: ['retry', 'queue'], draft: 'Queue it, keep the idempotency key.' },
    ],
    conflicts: [{ a: 'Atlas', b: 'Nova', files: ['src/auth.ts'], kind: 'merge', at: 1 }],
    lead: {
      briefs: [{ id: 'b1', ask: 'rate limit login', status: 'pending', title: 'Rate-limit login', goal: 'Stop brute force on /login', context: '', criteria: ['429 after 5 tries'], area: ['src/auth/**'], doNotTouch: [], verify: ['npm test'], deadEnds: [], outputFormat: 'PR link', budgetUsd: 3, assignees: ['Atlas'], createdAt: 1, revisions: 0 }],
      swaps: [], queue: [], groups: {}, mode: 'steady', muted: false, dismissed: [], drills: [], merged: [], digestHours: ['11', '16'],
    },
    burn: { '11111111-1111-4111-8111-111111111111': 2.4 },
    updatedAt: 1,
  }
}


const LEAD = '22222222-2222-4222-8222-222222222222'
const NOW = 1_800_000_000_000

/** Seeds the shared store and lets the Manager's poll build the board. */
type RunResult = { exitCode: number; stdout: string; stderr: string; isStdoutTruncated: boolean; isStderrTruncated: boolean }
const NO_PROCESS: RunResult = { exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false }

async function asManager($: Engine, on: On, o: { brief?: Partial<Brief>; run?: (argv: readonly string[]) => RunResult } = {}): Promise<void> {
  const clock = mock.clock(on, { now: NOW })
  const b = board()
  const entries: Record<string, unknown> = {
    'krew:lead': { sid: LEAD, token: 't', since: 0, root: '/r' },
    'krew:leadstate': { ...b.lead, briefs: b.lead.briefs.map(x => ({ ...x, ...o.brief })) },
    'krew:notes:x': b.notes,
    'krew:log:x': b.events,
  }
  for (const a of b.agents) entries[`krew:card:${a.sid}`] = { ...a, heartbeatAt: NOW, lastActivityAt: NOW, needs: [{ ...b.inbox[1] }] }
  mock.store(on, entries)
  mock.env(on, { HOME: '/home/test' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__kreative-krew__${e.name}` } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('agent.register', () => ({ value: { agent: 'kreative-krew:x' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: { isSent: false, reason: 'disabled' } }))
  on('session.send', () => ({ isDelivered: true }))
  on('session.id', () => ({ value: LEAD }))
  on('session.cwd', () => ({ value: '/r' }))
  on('session.root', () => ({ value: '/r' }))
  on('process.run', (_$, e) => ({ value: o.run ? o.run(e.argv) : NO_PROCESS }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }))
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await clock.advance(5000)
  await clock.settle()
}

test('the Manager dashboard shows NEEDS YOU, the brief and every tab', async ($, on) => {
  await asManager($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'kreative-krew', surface, component: 'Pane', requestId: 'krew', props: PANE_PROPS })
    expect(await ui.find({ text: /NEEDS YOU/ }), `${surface}: NEEDS YOU`).toBeDefined()
    expect(await ui.find({ text: /Brief for approval/ }), `${surface}: brief`).toBeDefined()
    expect(await ui.find({ key: 'ap-b1' }), `${surface}: approve button`).toBeDefined()
    expect(await ui.find({ text: /draft:/ }), `${surface}: draft`).toBeDefined()
    await ui.press({ key: 'tab-team' })
    expect(await ui.find({ text: /TEAM/ }), `${surface}: team`).toBeDefined()
    await ui.press({ key: 'tab-radar' })
    expect(await ui.find({ text: /COLLISION RADAR/ }), `${surface}: radar`).toBeDefined()
    await ui.press({ key: 'tab-money' })
    expect(await ui.find({ text: /TREASURY/ }), `${surface}: money`).toBeDefined()
    await ui.press({ key: 'tab-replay' })
    expect(await ui.find({ text: /FLIGHT RECORDER/ }), `${surface}: replay`).toBeDefined()
    await ui.press({ key: 'tab-inbox' })
    await ui.unmount()
  }
})

test('the full brief shows the founder exactly what the worker gets, and approving a plan brief hires at high effort', async ($, on) => {
  const runs: string[][] = []
  await asManager($, on, {
    brief: { assignees: [], hireName: 'Hunter', kind: 'plan', effort: 'high', roles: ['a CTO', 'an AI agent expert', 'a threat hunter'], task: 'Plan the threat-hunting agent.' },
    run: argv => {
      runs.push([...argv])
      return argv[0] === 'claude' ? { ...NO_PROCESS, exitCode: 0, stdout: '33333333-3333-4333-8333-333333333333' } : NO_PROCESS
    },
  })
  const ui = await $.ui.mount({ plugin: 'kreative-krew', surface: 'terminal', component: 'Pane', requestId: 'krew', props: PANE_PROPS })
  await ui.press({ key: 'full-b1' })
  expect(await ui.find({ text: /I am onboarding you as a CTO, an AI agent expert and a threat hunter/ })).toBeDefined()
  expect(await ui.find({ text: /Understand first/ })).toBeDefined()
  expect(await ui.find({ text: /ASD-STE100/ })).toBeDefined()
  await ui.press({ key: 'ap-b1' })
  const hire = runs.find(a => a[0] === 'claude' && a[1] === '--bg')
  expect(hire).toBeDefined()
  expect(hire?.slice(0, 4)).toEqual(['claude', '--bg', '--effort', 'high'])
  expect(hire?.at(-1)).toContain('## Task\nPlan the threat-hunting agent.')
})

test('a non-Manager session explains how to become one', async ($, on) => {
  mock.store(on)
  const ui = await $.ui.mount({ plugin: 'kreative-krew', surface: 'terminal', component: 'Pane', requestId: 'krew', props: PANE_PROPS })
  expect(await ui.find({ text: /krew-lead/ })).toBeDefined()
})

test('the band shows the crew and the inbox count', async ($, on) => {
  await asManager($, on)
  const ui = await $.ui.mount({
    plugin: 'kreative-krew', surface: 'terminal', component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100, scroll: { offset: 0, bodyRows: 6 }, view: {} },
  })
  expect(await ui.find({ text: /KREW/ })).toBeDefined()
  expect(await ui.find({ text: /need you/ })).toBeDefined()
})
