// Pure helpers: no `$`, safe to import from tests.

import type { Card, Need, Signals } from '../../types'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function uid(prefix = ''): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return prefix + Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 8)
}

export function hash(text: string): string {
  let h = 5381
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

export function short(text: string | undefined, max: number): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, Math.max(1, max - 1)) + '…' : one
}

export function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[#*_>|]/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

export function ago(now: number, at: number | undefined): string {
  if (!at) return '—'
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${String(m % 60).padStart(2, '0')}` : `${Math.round(h / 24)}d`
}

export function usd(n: number | undefined): string {
  const v = n ?? 0
  return v >= 100 ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`
}

export function roman(gen: number): string {
  const map: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]
  let n = Math.max(1, Math.min(39, gen))
  let out = ''
  for (const [v, s] of map) while (n >= v) { out += s; n -= v }
  return out
}

/** "Atlas" gen 2 -> "Atlas II"; strips an existing numeral first. */
export function successorName(name: string, gen: number): string {
  const base = name.replace(/\s+[IVX]+$/, '')
  return gen <= 1 ? base : `${base} ${roman(gen)}`
}

export function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent'
}

/** An agent name safe for argv, tmux targets, env files and tags: letters, digits, spaces, hyphens. */
export function cleanName(name: string | undefined): string {
  return (name ?? '').replace(/[^A-Za-z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20)
}

/** POSIX single-quoting, for the one place a command line goes through a shell (tmux). */
export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

export function shellJoin(argv: string[]): string {
  return argv.map(shellQuote).join(' ')
}

/**
 * Crew membership is opt-in: a session is a worker when it adopted a hire tag or
 * carries KREW_NAME, or when one of its paths (cwd, project root, git common dir)
 * lies under the Manager's project root. Anything else stays inert.
 */
export function isMember(leadRoot: string | undefined, paths: (string | undefined)[], tagSeen: boolean, envName: string): boolean {
  if (tagSeen || envName.trim()) return true
  const root = (leadRoot ?? '').replace(/\/+$/, '')
  if (!root) return false
  return paths.some(p => !!p && (p.replace(/\/+$/, '') === root || p.startsWith(`${root}/`)))
}

export const PR_URL = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/

export function isPrUrl(url: string): boolean {
  return new RegExp(`^${PR_URL.source}$`).test(url.trim())
}

/** First JSON object in a model reply, tolerant of fences and prose. */
export function parseJsonLoose<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fenced ? fenced[1] : text
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1)) as T
  } catch {
    return null
  }
}

export function strings(v: unknown, max = 8, len = 240): string[] {
  if (!Array.isArray(v)) return []
  return v.filter(x => typeof x === 'string' && x.trim()).slice(0, max).map(x => short(String(x), len))
}

export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback
}

/** A glob of `*`, `**` and `?` against a repo-relative path. */
export function globMatch(glob: string, path: string): boolean {
  const g = glob.replace(/^\.\//, '').replace(/\/$/, '/**')
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      re += '.*'
      i++
      if (g[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`).test(path.replace(/^\.\//, ''))
}

export function relTo(root: string, path: string): string {
  const r = root.endsWith('/') ? root : root + '/'
  return path.startsWith(r) ? path.slice(r.length) : path
}

export function emptySignals(): Signals {
  return {
    toolCalls: 0,
    toolErrors: 0,
    repeats: 0,
    pingPong: 0,
    rereads: 0,
    sameErrorFixes: 0,
    churn: 0,
    ruleBreaks: 0,
    invented: 0,
    redoAfterCompact: 0,
    corrections: 0,
    stallTurns: 0,
    compactions: 0,
  }
}

export function emptyCard(sid: string, name: string, now: number, cwd: string): Card {
  return {
    sid,
    name,
    gen: 1,
    lineage: [],
    state: 'idle',
    task: '',
    bullets: [],
    needs: [],
    repos: [],
    prs: [],
    contextPercent: 0,
    costUsd: 0,
    sharpness: 100,
    hard: [],
    signals: emptySignals(),
    mood: 'fresh',
    area: [],
    doNotTouch: [],
    cwd,
    turns: 0,
    startedAt: now,
    lastActivityAt: now,
    heartbeatAt: now,
    lastProgressAt: now,
  }
}

const RISK_OF: Record<string, number> = {
  rot: 3,
  stuck: 3,
  blocked: 3,
  budget: 2,
  conflict: 2,
  permission: 2,
  brief: 2,
  swap: 2,
  drill: 3,
  pr: 1,
  question: 1,
  approach: 1,
}

export function riskOf(n: Pick<Need, 'kind' | 'risk'>): number {
  return Math.max(n.risk ?? 0, RISK_OF[n.kind] ?? 1)
}

/** Highest risk first, then oldest first. */
export function rankNeeds(needs: Need[]): Need[] {
  return [...needs].sort((a, b) => riskOf(b) - riskOf(a) || a.at - b.at)
}

/** Parses `[krew:hire name="Atlas II" gen=2 handoff=h1 pred=<sid>]` tags. */
export function parseTag(text: string): { attrs: Record<string, string>; rest: string } | null {
  const open = text.match(/^\s*\[krew:hire(?=[\s\]])/)
  if (!open) return null
  // The closing bracket is the first `]` outside quotes, so a glob like `src/[ab]/**` survives.
  let i = open[0].length
  let quoted = false
  for (; i < text.length; i++) {
    const ch = text[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ']' && !quoted) break
  }
  if (i >= text.length) return null
  const body = text.slice(open[0].length, i)
  const attrs: Record<string, string> = {}
  for (const a of body.matchAll(/([a-zA-Z]+)=("([^"]*)"|\S+)/g)) attrs[a[1]] = a[3] ?? a[2]
  return { attrs, rest: text.slice(i + 1).replace(/^\s*/, '') }
}

export function makeTag(attrs: Record<string, string | number | undefined>): string {
  const parts = Object.entries(attrs)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}="${String(v).replace(/"/g, "'").replace(/\s+/g, ' ')}"`)
  return `[krew:hire ${parts.join(' ')}]`
}

/** Control messages between sessions: `[krew:ctl] {json}`. */
export type Ctl =
  | { op: 'freeze'; swapId: string; reason: string }
  | { op: 'retire'; force?: boolean }
  | { op: 'compact'; focus?: string }
  | { op: 'canary' }
  | { op: 'judge' }
  | { op: 'heads-up'; text: string }
  | { op: 'warm-ack' }

export const CTL = '[krew:ctl]'

export function encodeCtl(token: string, ctl: Ctl): string {
  return `${CTL} ${JSON.stringify({ ...ctl, token })}`
}

export function decodeCtl(text: string): (Ctl & { token?: string }) | null {
  const i = text.indexOf(CTL)
  if (i < 0) return null
  return parseJsonLoose<Ctl & { token?: string }>(text.slice(i + CTL.length))
}

export function moodOf(card: Pick<Card, 'sharpness' | 'contextPercent' | 'signals' | 'prs' | 'state'>): string {
  const s = card.signals
  if (card.state === 'frozen') return 'handing off'
  if (s.repeats + s.pingPong >= 3) return 'looping'
  if (card.sharpness < 40) return 'exhausted'
  if (card.contextPercent >= 70) return 'tired'
  if (card.prs.some(p => p.ci === 'pass')) return '+shipped'
  if (card.sharpness >= 85) return 'sharp'
  return 'focused'
}

export function bar(value: number, width: number, full = '█', empty = '░'): string {
  const n = Math.round((Math.max(0, Math.min(100, value)) / 100) * width)
  return full.repeat(n) + empty.repeat(Math.max(0, width - n))
}

export function sparkline(values: number[]): string {
  const ticks = '▁▂▃▄▅▆▇█'
  if (values.length === 0) return ''
  const max = Math.max(...values, 1e-9)
  return values.map(v => ticks[Math.min(7, Math.floor((v / max) * 7))]).join('')
}
