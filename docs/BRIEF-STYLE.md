# Brief style

Every ask the human gives the Manager compiles into one brief with a fixed shape. The human sees the brief in the Inbox (**Full brief** shows the exact text the worker receives) and picks **Approve & send**, **Revise** or **Reject**. Only an approved brief reaches a worker.

## Shape

| Part | Where it comes from |
|---|---|
| `I am onboarding you as …` (first line) | `roles`: 3-8 expert roles the compiler picks for the task, keeping any the human named |
| `## Task` | `task`: the ask with grammar fixed and stated clearly, same intent. The raw words stay on the brief as `ask`; the worker never sees them |
| `## Understand first` | fixed text in every brief: read the code deeply, not just docs; research and plan; only then proceed |
| Goal, Context, Acceptance criteria, owns / do-not-touch, Verify by, Dead ends | as before |
| `## Output` | only when `kind` is `plan` (plan, design or research): one Claude HTML artifact with the complete plan (UI to backend, architecture, agent architecture) in ASD-STE100 Simplified Technical English, with diagrams |
| When done, Budget | as before |
| `## Standing rules` | the `standingRules` option, appended to every brief when set |

**Effort.** A `plan` brief always carries `effort: high`; the compiler may also set it for a first task in an unfamiliar area. A brief that hires a new worker starts it with `claude --effort <level>`. A brief sent to an existing worker cannot change that session's effort. An `--effort` in the `claudeArgs` option wins over the brief.

## Standing rules option

Set `standingRules` in `/config`, or in `settings.json` for multi-line text (`pluginConfigs` → the plugin id `claude plugin list` shows, e.g. `kreative-krew@kreative-krew` → `options`). The SecNode value:

```json
"standingRules": "- Worktrees and clones under SECNODE/tmp/ only. One PR per repo. Never merge; the founder merges.\n- PR body: short bullets What / Why / Risk / Tested, then the Claude Code footer. Commits end with the Co-Authored-By line.\n- Test email is pardha@secnode.ai. Tell the founder before sending any email."
```

## Fixture: messy ask → brief

Raw ask, as the founder typed it (`tests/brief.test.ts`, `RAW_ASK`):

> I am onboarding you as the founding product stagest, fullstack devlloper ,cto , lead product desiner , prodcut archeture specialist , AI agent expert , worked in threadhunding and blue teaming and build and scaled offensive defensive tools. first understand entire secnode codebase deeply do not stuck with documentation read the code. task: secnode founder had a potentional converstaion and the result is one of the client have a rewuirement in thread hunting . he is working with azure telemeary logs alot hw is asking for building a secnode agent pul lthe logs and analysis it and find threats inside his envoment ... in the settings user conenct the azure telemery ... secnode agent pull it analyse it and using LLM and act like a lead threat hunter and find threads. the output is complete plan with ui to backend and entire arcerutre and agent archetire ... ony proceed after rearach planing. outpur clade html artifact with complete plan use ASD-STE100 for the claude artifact and dagram

`claude-sonnet-5-5` compiled it with `BRIEF_SYSTEM` on 2026-10-16 (`COMPILED` in the same test; one context sentence that came from the test machine's own CLAUDE.md was removed). `renderBrief` gives the text below, with a short version of the SecNode standing rules set. `effort` is `high`, so the hire runs `claude --bg --effort high -n Hunter …`.

````markdown
I am onboarding you as a founding product strategist, a full-stack developer, a CTO, a lead product designer, a product architecture specialist, an AI agent expert, a threat hunter and blue-team engineer and a builder and scaler of offensive and defensive security tools.

# Brief b1: Plan: SecNode Azure telemetry threat-hunting agent (UI to backend to …

## Task
A client of the SecNode founder works heavily with Azure telemetry logs and needs a threat-hunting capability. Research and plan a SecNode agent that pulls the client's Azure telemetry logs, analyses them, and uses an LLM to act like a lead threat hunter and find threats inside the client's environment. In Settings, the user connects their Azure telemetry source. The SecNode agent then pulls the logs, analyses them, and reports threats. The deliverable is a complete plan covering the UI, the backend, the full system architecture and the agent architecture. Base the plan on the actual SecNode code, not only on documentation. Do research and planning only; do not write product code.

## Understand first
- Understand the relevant codebase deeply before you change anything.
- Read the code, not just the docs: docs drift from the code.
- Research and plan: what you read, the options, the approach you pick and why.
- Only proceed after the research and the plan are done.

## Goal
Produce a code-grounded, complete plan for an Azure-telemetry-driven AI threat-hunting agent in SecNode, covering UI, backend, architecture and agent design.

## Context
No worker has seen this repo yet. The user wants the real code read in depth, not just docs. The plan must fit the existing SecNode stack, patterns, settings and integration flows, and the existing agent and LLM code. Azure sources to consider include Microsoft Sentinel and Log Analytics, Entra ID sign-in and audit logs, Azure Activity logs, NSG flow logs, Defender for Cloud, and Event Hub streaming. Cover auth, least-privilege read access, data volume and cost, multi-tenancy, and LLM data privacy.

## Acceptance criteria
- Plan cites real SecNode modules, files and patterns found in the code, and says what to reuse versus build new
- Covers Settings UI flow for connecting Azure, plus the findings, hunt and investigation screens, from UI down to backend and data model
- Defines the agent architecture: hunt hypotheses, KQL or query tools, planner, triage, evidence chain, LLM guardrails, MITRE ATT&CK mapping
- Includes a system architecture diagram and an agent flow diagram, plus phased rollout, risks and open questions
- Written in ASD-STE100 Simplified Technical English as a single self-contained Claude HTML artifact

## Do NOT touch
- **/*.lock
- **/package-lock.json
- **/migrations/**
- .github/**

## Verify by
- Check that each claimed SecNode module or file path exists in the code
- Check that the HTML opens standalone and that the diagrams render
- Review the text for STE rules: short sentences, active voice, approved terms, one idea per sentence
- Check that every acceptance criterion maps to a section in the artifact

## Output
A Claude HTML artifact with the complete plan: UI to backend, the entire architecture and, where agents are involved, the agent architecture. Write it in ASD-STE100 Simplified Technical English and include diagrams. This task delivers the plan, not the build.

## When done
One self-contained HTML artifact in ASD-STE100 style, with diagrams, delivered as the Claude artifact. Final report: artifact link, a summary of 5 lines or fewer, and a list of open questions for the founder.

Budget: about $10.00. Stop and ask_manager before going far over it.

## Standing rules
- Worktrees and clones under SECNODE/tmp/ only. One PR per repo. Never merge; the founder merges.
- PR body: short bullets What / Why / Risk / Tested.
- Test email is pardha@secnode.ai; tell the founder before sending any email.
````
