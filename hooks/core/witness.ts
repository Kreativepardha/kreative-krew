// The Witness: pure signal tracking and the Sharpness score.
// Thresholds follow the research notes in docs/RESEARCH.md: hard triggers
// (correction loops, context near compaction, rule breaks) swap on their own;
// soft triggers only count in pairs and send the worker to a fresh judge.

import type { Signals } from '../../types'
import { emptySignals, globMatch, hash } from './util'

export type ToolSample = {
  tool: string
  key: string
  isError: boolean
  errorText?: string
  file?: string
  isEdit: boolean
  isRead: boolean
  isTest: boolean
  isProgress: boolean
}

export type WitnessState = {
  signals: Signals
  ring: string[]
  readsSinceEdit: Record<string, number>
  editsSinceTest: Record<string, number>
  failSigs: Record<string, { count: number; editsSince: number }>
  preCompact: Set<string>
  sinceCompact: number
  window: { error: boolean }[]
  editedThisTurn: boolean
}

export function newWitness(): WitnessState {
  return {
    signals: emptySignals(),
    ring: [],
    readsSinceEdit: {},
    editsSinceTest: {},
    failSigs: {},
    preCompact: new Set(),
    sinceCompact: -1,
    window: [],
    editedThisTurn: false,
  }
}

// A test runner in command position (start, or after ; && | ( ), never the word "test" in a path.
const TEST_CMD = /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck)\b|(?:npx\s+|\.\/node_modules\/\.bin\/)?(?:jest|vitest|mocha|tsc|eslint|pytest|rspec|phpunit)\b|go\s+test\b|cargo\s+(?:test|check|clippy)\b|make\s+(?:test|check)\b|python3?\s+-m\s+(?:pytest|unittest)\b|(?:dotnet|mvn|gradle|\.\/gradlew|swift|flutter|mix)\s+test\b)/
const INVENTED = /no such file|ENOENT|does not exist|cannot find module|could not resolve|is not defined|not a git repository|command not found|unknown option/i

export function isTestCommand(cmd: string): boolean {
  return TEST_CMD.test(cmd)
}

/** Normalises an error to a signature that survives line numbers and paths. */
export function errorSignature(text: string): string {
  const line =
    text
      .split('\n')
      .map(l => l.trim())
      .find(l => /error|fail|exception|assert/i.test(l)) ?? text.trim().split('\n')[0] ?? ''
  return hash(line.replace(/\d+/g, 'N').replace(/\/[\w./-]+/g, 'P').slice(0, 200))
}

/** Records one finished tool call; returns the names of signals it moved. */
export function observe(w: WitnessState, s: ToolSample): string[] {
  const moved: string[] = []
  const sig = w.signals
  sig.toolCalls++
  w.window.push({ error: s.isError })
  if (w.window.length > 30) w.window.shift()
  if (s.isError) sig.toolErrors++

  // Repetition: the same call with the same outcome three times in the ring.
  const h = hash(`${s.tool}|${s.key}|${s.isError ? 'E' : 'ok'}`)
  const seen = w.ring.filter(x => x === h).length
  if (seen >= 2 && !s.isRead) {
    sig.repeats++
    moved.push('repeats')
  }
  w.ring.push(h)
  if (w.ring.length > 30) w.ring.shift()

  // A→B→A→B ping-pong.
  const r = w.ring
  if (r.length >= 4) {
    const [a, b, c, d] = r.slice(-4)
    if (a === c && b === d && a !== b) {
      sig.pingPong++
      moved.push('pingPong')
    }
  }

  // Re-reading a file again and again with no edit in between.
  if (s.isRead && s.file) {
    const n = (w.readsSinceEdit[s.file] ?? 0) + 1
    w.readsSinceEdit[s.file] = n
    if (n === 3) {
      sig.rereads++
      moved.push('rereads')
    }
  }

  if (s.isEdit && s.file) {
    w.readsSinceEdit[s.file] = 0
    w.editedThisTurn = true
    const n = (w.editsSinceTest[s.file] ?? 0) + 1
    w.editsSinceTest[s.file] = n
    if (n === 6) {
      sig.churn++
      moved.push('churn')
    }
    for (const f of Object.values(w.failSigs)) f.editsSince++
  }

  // The same failure coming back after edits meant to fix it.
  if (s.isError && s.errorText && (s.isTest || s.tool === 'Bash')) {
    const key = errorSignature(s.errorText)
    const f = w.failSigs[key] ?? { count: 0, editsSince: 0 }
    if (f.count > 0 && f.editsSince > 0) {
      f.count++
      if (f.count - 1 > sig.sameErrorFixes) {
        sig.sameErrorFixes = f.count - 1
        moved.push('sameErrorFixes')
      }
    } else if (f.count === 0) f.count = 1
    f.editsSince = 0
    w.failSigs[key] = f
  }

  if (s.isTest && !s.isError) {
    w.editsSinceTest = {}
    w.failSigs = {}
  }

  if (s.isError && s.errorText && INVENTED.test(s.errorText)) {
    sig.invented++
    moved.push('invented')
  }

  // Redoing work after a compaction: an identical successful call from before it.
  if (w.sinceCompact >= 0 && !s.isError && !s.isRead && w.preCompact.has(h)) {
    sig.redoAfterCompact++
    moved.push('redoAfterCompact')
  }
  if (w.sinceCompact >= 0) w.sinceCompact++

  return moved
}

export function markCompaction(w: WitnessState): void {
  w.signals.compactions++
  w.preCompact = new Set(w.ring)
  w.sinceCompact = 0
}

/** Edits that land outside the owned area, or inside the do-not-touch list. */
export function breaksRules(path: string, area: string[], doNotTouch: string[]): boolean {
  if (doNotTouch.some(g => globMatch(g, path))) return true
  if (area.length > 0 && !area.some(g => globMatch(g, path))) return true
  return false
}

const CORRECTION = /\b(still (not|broken|fail|wrong)|doesn'?t work|not working|same (error|issue|problem)|that'?s (wrong|not (it|right))|you (didn'?t|broke)|again\b|try again|it'?s broken|wrong)\b/i

export function isCorrection(prompt: string): boolean {
  return CORRECTION.test(prompt)
}

export function errorRate(w: WitnessState): number {
  if (w.window.length < 8) return 0
  return w.window.filter(x => x.error).length / w.window.length
}

export type Verdict = { sharpness: number; hard: string[]; soft: string[] }

/**
 * Sharpness 0..100 and the triggers behind it.
 * Hard (any one): 2+ failed fixes of one error or 2+ human corrections,
 * context near auto-compact, rule breaks. Soft: everything else.
 */
export function assess(sig: Signals, contextPercent: number, errRate: number, opts?: { compactNear?: number }): Verdict {
  const hard: string[] = []
  const soft: string[] = []
  const compactNear = opts?.compactNear ?? 85

  if (sig.sameErrorFixes >= 2) hard.push(`same error after ${sig.sameErrorFixes + 1} fix attempts`)
  if (sig.corrections >= 2) hard.push(`${sig.corrections} corrections on recent work`)
  if (contextPercent >= compactNear) hard.push(`context ${Math.round(contextPercent)}%`)
  if (sig.ruleBreaks >= 2) hard.push(`${sig.ruleBreaks} edits outside its area`)

  if (sig.repeats >= 2) soft.push(`repeated calls ×${sig.repeats}`)
  if (sig.pingPong >= 1) soft.push('ping-pong between two calls')
  if (sig.rereads >= 2) soft.push(`re-read files ×${sig.rereads}`)
  if (sig.redoAfterCompact >= 1) soft.push('redid work after compaction')
  if (sig.churn >= 1) soft.push('edit churn without tests')
  if (errRate >= 0.35) soft.push(`tool errors ${Math.round(errRate * 100)}%`)
  if (sig.invented >= 2) soft.push(`missing paths/symbols ×${sig.invented}`)
  if (sig.stallTurns >= 5) soft.push(`no progress for ${sig.stallTurns} turns`)

  let score = 100
  score -= Math.max(0, contextPercent - 40) * 0.6
  score -= Math.min(30, sig.repeats * 6 + sig.pingPong * 8 + sig.rereads * 3)
  score -= Math.min(30, sig.sameErrorFixes * 12 + sig.corrections * 10)
  score -= Math.min(24, sig.ruleBreaks * 8 + sig.invented * 4)
  score -= Math.min(20, sig.redoAfterCompact * 7 + sig.churn * 5)
  score -= errRate >= 0.35 ? 10 : 0
  score -= Math.min(15, Math.max(0, sig.stallTurns - 3) * 3)
  if (sig.canary !== undefined) score -= (1 - sig.canary) * 30
  if (sig.judge !== undefined) score -= (1 - sig.judge) * 35

  if (sig.canary !== undefined && sig.canary < 0.5) hard.push('failed the canary quiz')
  if (sig.judge !== undefined && sig.judge < 0.4) hard.push('fresh-eyes judge scored it low')

  return { sharpness: Math.max(0, Math.min(100, Math.round(score))), hard, soft }
}

export type Action = 'none' | 'judge' | 'compact' | 'swap'

/** What the Manager should do about a worker right now. */
export function decide(v: Verdict, contextPercent: number, rotateAt: number, atBoundary: boolean): { action: Action; planned: boolean } {
  if (v.hard.length > 0 || v.sharpness < 40) return { action: 'swap', planned: false }
  if (contextPercent >= rotateAt && atBoundary) return { action: 'swap', planned: true }
  if (v.soft.length >= 2) return { action: 'judge', planned: false }
  if (v.sharpness < 70) return { action: 'compact', planned: false }
  return { action: 'none', planned: false }
}
