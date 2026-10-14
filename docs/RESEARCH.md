# Research behind Kreative Krew

Design decisions in this mod trace back to published work and practitioner write-ups. Numbers below are as reported by the cited sources; treat them as pointers, not gospel.

## 1. Spawning agents is solved; integrating them is not

Surveying ~25 fleet tools (Claude Squad, Conductor, vibe-kanban, Sculptor, container-use, uzi, Cursor's agents window, the Codex app, GitHub Agent HQ, Gas Town, Claude Code agent teams…) the recurring unsolved pains were: human review that stops scaling around 4–8 agents, branches that pass alone and break together, runtime collisions (ports, databases, caches), coordinators that drift into coding, state lost on crash/resume, and cost opacity.

→ Kreative Krew's pillars are exactly that integration layer: evidence inbox, collision radar, refinery, runtime isolation, treasury, a Manager that cannot edit code.

Sources: [openalternative orchestrator roundup](https://openalternative.co/blog/best-ai-coding-agent-orchestrators) · [Gas Town write-up](https://maggieappleton.com/gastown) · [GitHub Mission Control](https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/) · [vibe-kanban shutdown note](https://vibekanban.com/shutdown) · [Dagger container-use](https://dagger.io/blog/agent-container-use)

## 2. One writer per area, many readers

- Cognition (2026): parallel agents that all edit the same work still mostly fail; analysis and review parallelise, writes should stay single-threaded. [cognition.com/blog/multi-agents-working](https://cognition.com/blog/multi-agents-working)
- Google Research, *Towards a science of scaling agent systems*: independent agents amplified errors 17.2×; an orchestrator held it to 4.4×; every multi-agent setup made sequential tasks 39–70% worse. [arXiv 2512.08296](https://arxiv.org/abs/2512.08296)
- Xu et al. 2026 (33,596 agent PRs): 79% overlapped in time with another agent PR; cross-agent pairs conflicted 41.7% vs 19.8% same-agent.
- MAST (NeurIPS 2025): most multi-agent failures are system-design failures; step repetition 15.7%, reasoning–action mismatch 13.2%, not knowing when to stop 12.4%, incorrect verification 9.1%; a final re-check against the original goal gave +15.6%. [arXiv 2503.13657](https://arxiv.org/abs/2503.13657)

→ Briefs carry an owned area and a do-not-touch list; edits outside them count as rule breaks. The verification triad ends with a goal checker.

## 3. Conflicts can be predicted

- Brun et al. (FSE 2011), *Proactive detection of collaboration conflicts*: speculative background merging finds conflicts, including build/test breaks, long before integration. [paper](https://cs.ubc.ca/~rtholmes/papers/fse_2011_brun.pdf)
- Owhadi-Kareshk et al.: a cheap git-feature classifier predicts *safe* merges with F1 0.95–0.97. [arXiv 1907.06274](https://arxiv.org/abs/1907.06274)
- Merge queues with speculative checks: [Mergify docs](https://doc.mergify.io/merge-queue/speculative-checks).

→ The radar runs `git merge-tree --write-tree` between every pair of live branches every 3 minutes; the refinery serialises merges and rebases.

## 4. Verification that actually helps

- AgentCoder: a test designer that never sees the code lifted pass rates markedly over single-agent baselines. [arXiv 2312.13010](https://arxiv.org/abs/2312.13010)
- Devin Review (Cognition): a fresh-context reviewer finds ~2 bugs per PR, 58% severe.
- Anthropic's research system: a single-rubric LLM judge; ~20 cases is enough to start. [anthropic.com/engineering/multi-agent-research-system](https://www.anthropic.com/engineering/multi-agent-research-system)

→ Every PR gets three mod-registered subagents: fresh reviewer, independent test writer, goal checker. Their verdicts are the “evidence” line in the inbox.

## 5. Human attention is the scarce resource

- Anthropic, *Measuring agent autonomy* (Feb 2026): when Claude stops itself, 35% of the time it is to offer a choice of approaches, 21% to gather diagnostics, 13% to clarify. Experienced users interrupt more, not less. [anthropic.com/research/measuring-agent-autonomy](https://www.anthropic.com/research/measuring-agent-autonomy)
- OpenAI, *A practical guide to building agents*: rank escalations by irreversibility and repeated failure.

→ “Approach” questions are batched with pre-drafted answers; the inbox ranks by risk; the storyteller's modes set the interruption threshold; autonomy is earned per area.

## 6. Context rot and succession

- Chroma, *Context Rot* (2025): all 18 models tested degrade as input grows, unevenly. [research.trychroma.com/context-rot](https://research.trychroma.com/context-rot)
- NoLiMa (ICML 2025): 11 of 13 models fall below 50% of their short-context score by 32K tokens. [arXiv 2502.05167](https://arxiv.org/abs/2502.05167)
- RULER: usable context is far shorter than advertised. [arXiv 2404.06654](https://arxiv.org/abs/2404.06654)
- Laban et al. (ICLR 2026): multi-turn performance drops 39% on average, mostly from committing to early wrong turns. [arXiv 2505.06120](https://arxiv.org/abs/2505.06120)
- Anthropic, *Effective harnesses for long-running agents*: compaction alone is not enough; use progress files, feature lists with pass flags, fresh sessions. [link](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- Claude Code best practices: after 2+ failed corrections on the same issue, start fresh. Amp: *extract, don't summarize* for handoffs. [ampcode.com/news/handoff](https://ampcode.com/news/handoff)
- JetBrains: hiding old tool outputs matched LLM summarisation on SWE-bench at about half the cost. [arXiv 2508.21433](https://arxiv.org/abs/2508.21433)

→ Hard triggers: 2+ failed fixes of the same error, 2+ human corrections, context near auto-compact, repeated rule breaks. Soft signals only count in pairs and send the worker to a fresh judge. Planned rotation happens at a commit/test boundary once context passes `rotateAt` (default 50%). The handoff packet is built from git and the event log; the predecessor's account is audited by a separate judge; the successor re-verifies every “done” claim. Thresholds are deliberately configurable: newer models may need fewer resets.

## 7. Loop and stall detection

- OpenRouter doom-loop detection: hash (tool, args, result); observe at 2 repeats, block at 3, kill at 6.
- Magentic-One: a progress ledger; replan when it stalls. [docs](https://microsoft.github.io/autogen/0.4.3/user-guide/agentchat-user-guide/magentic-one.html)
- Anthropic, *Building a C compiler with parallel agents*: claim files, logs of failed approaches, `--fast` deterministic test samples per agent. [link](https://www.anthropic.com/engineering/building-c-compiler)

→ The Witness implements exactly those heuristics; `krew_note` is the shared log of dead ends, and every brief carries the relevant ones.

## Metrics the mod records so you can check the claims

Conflicts per PR, human interrupts per merged PR, cost per merged PR, successor-vs-predecessor progress, and succession false positives (dismissed swap proposals) all live in the event log and the Treasury tab.
