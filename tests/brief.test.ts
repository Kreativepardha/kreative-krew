import { describe, expect, test } from 'claude-code/testing'

import { applyCompiled, draftBrief, renderBrief } from '../hooks/core/brief'
import { cfg } from '../hooks/core/io'

/** A founder's raw ask, kept with its typos: the compiler must clean it without changing intent. */
const RAW_ASK =
  'I am onboarding you as the founding product stagest, fullstack devlloper ,cto , lead product desiner , prodcut archeture specialist , AI agent expert , worked in threadhunding and blue teaming and build and scaled offensive defensive tools. first understand entire secnode codebase deeply do not stuck with documentation read the code. task: secnode founder had a potentional converstaion and the result is one of the client have a rewuirement in thread hunting . he is working with azure telemeary logs alot hw is asking for building a secnode agent pul lthe logs and analysis it and find threats inside his envoment ... in the settings user conenct the azure telemery ... secnode agent pull it analyse it and using LLM and act like a lead threat hunter and find threads. the output is complete plan with ui to backend and entire arcerutre and agent archetire ... ony proceed after rearach planing. outpur clade html artifact with complete plan use ASD-STE100 for the claude artifact and dagram'

/** What the smart model returned for RAW_ASK with BRIEF_SYSTEM (claude-sonnet-5-5, 2026-10-16). */
const COMPILED = {
  title: 'Plan: SecNode Azure telemetry threat-hunting agent (UI to backend to agent architecture)',
  task: "A client of the SecNode founder works heavily with Azure telemetry logs and needs a threat-hunting capability. Research and plan a SecNode agent that pulls the client's Azure telemetry logs, analyses them, and uses an LLM to act like a lead threat hunter and find threats inside the client's environment. In Settings, the user connects their Azure telemetry source. The SecNode agent then pulls the logs, analyses them, and reports threats. The deliverable is a complete plan covering the UI, the backend, the full system architecture and the agent architecture. Base the plan on the actual SecNode code, not only on documentation. Do research and planning only; do not write product code.",
  roles: [
    'a founding product strategist',
    'a full-stack developer',
    'a CTO',
    'a lead product designer',
    'a product architecture specialist',
    'an AI agent expert',
    'a threat hunter and blue-team engineer',
    'a builder and scaler of offensive and defensive security tools',
  ],
  kind: 'plan',
  effort: 'high',
  goal: 'Produce a code-grounded, complete plan for an Azure-telemetry-driven AI threat-hunting agent in SecNode, covering UI, backend, architecture and agent design.',
  context:
    'No worker has seen this repo yet. The user wants the real code read in depth, not just docs. The plan must fit the existing SecNode stack, patterns, settings and integration flows, and the existing agent and LLM code. Azure sources to consider include Microsoft Sentinel and Log Analytics, Entra ID sign-in and audit logs, Azure Activity logs, NSG flow logs, Defender for Cloud, and Event Hub streaming. Cover auth, least-privilege read access, data volume and cost, multi-tenancy, and LLM data privacy.',
  criteria: [
    'Plan cites real SecNode modules, files and patterns found in the code, and says what to reuse versus build new',
    'Covers Settings UI flow for connecting Azure, plus the findings, hunt and investigation screens, from UI down to backend and data model',
    'Defines the agent architecture: hunt hypotheses, KQL or query tools, planner, triage, evidence chain, LLM guardrails, MITRE ATT&CK mapping',
    'Includes a system architecture diagram and an agent flow diagram, plus phased rollout, risks and open questions',
    'Written in ASD-STE100 Simplified Technical English as a single self-contained Claude HTML artifact',
  ],
  area: [],
  doNotTouch: ['**/*.lock', '**/package-lock.json', '**/migrations/**', '.github/**'],
  verify: [
    'Check that each claimed SecNode module or file path exists in the code',
    'Check that the HTML opens standalone and that the diagrams render',
    'Review the text for STE rules: short sentences, active voice, approved terms, one idea per sentence',
    'Check that every acceptance criterion maps to a section in the artifact',
  ],
  deadEnds: [],
  outputFormat:
    'One self-contained HTML artifact in ASD-STE100 style, with diagrams, delivered as the Claude artifact. Final report: artifact link, a summary of 5 lines or fewer, and a list of open questions for the founder.',
  budgetUsd: 10,
  assignees: [],
  hireName: 'Hunter',
}

const SECNODE_RULES = [
  '- Worktrees and clones under SECNODE/tmp/ only. One PR per repo. Never merge; the founder merges.',
  '- PR body: short bullets What / Why / Risk / Tested.',
  '- Test email is pardha@secnode.ai; tell the founder before sending any email.',
].join('\n')

function withRules<T>(rules: string, fn: () => T): T {
  const before = cfg.standingRules
  cfg.standingRules = rules
  try {
    return fn()
  } finally {
    cfg.standingRules = before
  }
}

describe('brief style', () => {
  test('the fixture keeps the raw ask but the worker reads the cleaned task', async () => {
    const b = applyCompiled(draftBrief(RAW_ASK, 0), COMPILED, [])
    expect(b.ask).toBe(RAW_ASK)
    const text = renderBrief(b)
    expect(text).toContain('## Task\nA client of the SecNode founder works heavily with Azure telemetry logs')
    expect(text).not.toContain('telemeary')
    expect(text).not.toContain(RAW_ASK.slice(0, 40))
  })

  test('the tailored team opens the brief', async () => {
    const text = renderBrief(applyCompiled(draftBrief(RAW_ASK, 0), COMPILED, []))
    expect(text.split('\n')[0]).toBe(
      'I am onboarding you as a founding product strategist, a full-stack developer, a CTO, a lead product designer, a product architecture specialist, an AI agent expert, a threat hunter and blue-team engineer and a builder and scaler of offensive and defensive security tools.',
    )
  })

  test('roles are capped at eight and a brief without roles has no onboarding line', async () => {
    const many = applyCompiled(draftBrief('x', 0), { roles: Array.from({ length: 12 }, (_, i) => `a role ${i}`) }, [])
    expect(many.roles).toHaveLength(8)
    expect(renderBrief(applyCompiled(draftBrief('fix the typo', 0), { goal: 'typo fixed' }, []))).not.toContain('onboarding')
  })

  test('every brief has the fixed understand-first section before the goal', async () => {
    for (const kind of ['plan', 'build']) {
      const text = renderBrief(applyCompiled(draftBrief('x', 0), { ...COMPILED, kind }, []))
      expect(text).toContain('## Understand first')
      expect(text).toContain('Read the code, not just the docs')
      expect(text).toContain('Only proceed after the research and the plan are done.')
      expect(text.indexOf('## Understand first')).toBeLessThan(text.indexOf('## Goal'))
    }
  })

  test('a plan brief asks for an ASD-STE100 HTML artifact and hires at high effort', async () => {
    const b = applyCompiled(draftBrief(RAW_ASK, 0), { ...COMPILED, effort: '' }, [])
    expect(b.kind).toBe('plan')
    expect(b.effort).toBe('high')
    const text = renderBrief(b)
    expect(text).toContain('## Output\nA Claude HTML artifact with the complete plan: UI to backend')
    expect(text).toContain('ASD-STE100')
    expect(text).toContain('diagrams')
  })

  test('a build brief has no plan output and keeps only a valid effort', async () => {
    const build = applyCompiled(draftBrief('x', 0), { ...COMPILED, kind: 'build', effort: 'turbo' }, [])
    expect(build.effort).toBeUndefined()
    expect(renderBrief(build)).not.toContain('## Output')
    expect(applyCompiled(draftBrief('x', 0), { kind: 'build', effort: 'xhigh' }, []).effort).toBe('xhigh')
  })

  test('standing rules close every brief when configured, and are absent when not', async () => {
    const b = applyCompiled(draftBrief(RAW_ASK, 0), COMPILED, [])
    const text = withRules(SECNODE_RULES, () => renderBrief(b))
    expect(text.endsWith(`## Standing rules\n${SECNODE_RULES}`)).toBe(true)
    expect(withRules('', () => renderBrief(b))).not.toContain('Standing rules')
  })

  test('a revision that leaves fields out keeps the cleaned task, roles and kind', async () => {
    const first = applyCompiled(draftBrief(RAW_ASK, 0), COMPILED, [])
    const revised = applyCompiled(first, { goal: 'narrower goal' }, [])
    expect(revised.task).toBe(first.task)
    expect(revised.roles).toEqual(first.roles)
    expect(revised.kind).toBe('plan')
    expect(revised.effort).toBe('high')
    const build = applyCompiled(draftBrief('x', 0), { kind: 'build', effort: 'xhigh' }, [])
    expect(applyCompiled(build, { goal: 'g' }, []).effort).toBe('xhigh')
    expect(applyCompiled(build, { goal: 'g', effort: '' }, []).effort).toBeUndefined()
  })
})
