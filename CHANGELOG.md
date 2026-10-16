# Changelog

## 0.3.0 — 2026-10-16
- Brief style: every brief opens with a tailored team (“I am onboarding you as …”), carries the cleaned task (the raw ask is kept on the brief), a fixed “Understand first” section and, for plan tasks, an ASD-STE100 HTML-artifact output. Plan briefs hire with `claude --effort high`.
- New `standingRules` option, appended to every brief.
- **Full brief** in the Inbox shows the exact text the worker receives.

## 0.2.0 — 2026-10-14
- Crew membership is opt-in: a session is a worker only when hired (hire tag / `KREW_NAME`) or under the Manager's project root; the Manager ignores cards from non-members.
- Hardened hiring: shell-quoted tmux command, sanitised agent names, PR URLs validated before reaching `gh`.
- Lead-state writes serialised; approve / swap / reply guarded against double presses; rejected swaps cool down before being proposed again.
- Tighter test-command detection, quote-aware hire tags, pruning of stale cards and module maps.
- `/krew-demo` refinements, cleaner inbox rows, demo recording in the README.

## 0.1.0 — 2026-10-14
- First release: Manager + workers, brief compiler with human approval, evidence inbox, Witness, succession with audited handoff, collision radar, refinery, treasury, flight recorder, storyteller modes, demo mode.
