// Everything that touches `$`: the shared store, models, git and the CLI.
// Each helper is a top-level function declaration, as the validator asks.
//
// Store layout (single writer per key, so sessions never race):
//   krew:lead            { sid, token, since }          written by /krew-lead
//   krew:card:<sid>      Card                           written by that worker
//   krew:log:<sid>       KEvent[] (ring)                written by that session
//   krew:notes:<sid>     Note[]   (ring)                written by that session
//   krew:leadstate       LeadState                      written by the Manager
//   krew:handoff:<id>    HandoffPacket | raw handoff     worker, then Manager
//   krew:retired:<sid>   { name, report, at }           written by that worker

import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Card, KEvent, LeadState, Note } from '../../types'
import { num, parseJsonLoose, str } from './util'

type $T = EngineInterface

export const KEY = {
  lead: 'krew:lead',
  card: (sid: string) => `krew:card:${sid}`,
  log: (sid: string) => `krew:log:${sid}`,
  notes: (sid: string) => `krew:notes:${sid}`,
  leadState: 'krew:leadstate',
  handoff: (id: string) => `krew:handoff:${id}`,
  retired: (sid: string) => `krew:retired:${sid}`,
}

export const cfg = {
  fastModel: 'claude-haiku-5-5',
  smartModel: 'claude-sonnet-5-5',
  workerModel: '',
  hireMode: 'bg' as 'bg' | 'tmux',
  rotateAt: 50,
  defaultBudgetUsd: 5,
  canary: true,
  claudeArgs: '',
  standingRules: '',
}

export function applyOptions(options: PluginOptions): void {
  cfg.fastModel = str(options.fastModel, cfg.fastModel) || cfg.fastModel
  cfg.smartModel = str(options.smartModel, cfg.smartModel) || cfg.smartModel
  cfg.workerModel = str(options.workerModel, '')
  cfg.hireMode = options.hireMode === 'tmux' ? 'tmux' : 'bg'
  cfg.rotateAt = Math.max(20, Math.min(90, num(options.rotateAt, 50)))
  cfg.defaultBudgetUsd = Math.max(0.5, num(options.defaultBudgetUsd, 5))
  cfg.canary = options.canary !== false
  cfg.claudeArgs = str(options.claudeArgs, '')
  cfg.standingRules = str(options.standingRules, '').trim()
}

/** `root` is the Manager's project root: sessions under it are crew members. */
export type LeadRecord = { sid: string; token: string; since: number; root?: string }

export async function readLead($: $T): Promise<LeadRecord | null> {
  const v = (await $.store.get(KEY.lead)) as LeadRecord | undefined
  return v && typeof v.sid === 'string' ? v : null
}

export async function readCard($: $T, sid: string): Promise<Card | null> {
  const v = (await $.store.get(KEY.card(sid))) as Card | undefined
  return v && typeof v.sid === 'string' ? v : null
}

export async function writeCard($: $T, card: Card): Promise<void> {
  await $.store.set(KEY.card(card.sid), card)
}

/** `keys` lets one `$.store.keys()` serve several reads (the poll passes it). */
export async function readCards($: $T, keys?: string[]): Promise<Card[]> {
  const mine = (keys ?? (await $.store.keys())).filter(k => k.startsWith('krew:card:'))
  const cards = await Promise.all(mine.map(k => $.store.get(k) as Promise<Card | undefined>))
  return cards.filter((c): c is Card => !!c && typeof c.sid === 'string')
}

export async function appendLog($: $T, ev: KEvent): Promise<void> {
  const key = KEY.log(ev.sid)
  const list = ((await $.store.get(key)) as KEvent[] | undefined) ?? []
  list.push(ev)
  await $.store.set(key, list.slice(-120))
}

export async function readLogs($: $T, limit = 400, keys?: string[]): Promise<KEvent[]> {
  const mine = (keys ?? (await $.store.keys())).filter(k => k.startsWith('krew:log:'))
  const lists = await Promise.all(mine.map(k => $.store.get(k) as Promise<KEvent[] | undefined>))
  return lists
    .flatMap(l => l ?? [])
    .sort((a, b) => a.at - b.at)
    .slice(-limit)
}

export async function appendNote($: $T, note: Note): Promise<void> {
  const key = KEY.notes(note.sid)
  const list = ((await $.store.get(key)) as Note[] | undefined) ?? []
  list.push(note)
  await $.store.set(key, list.slice(-30))
}

export async function readNotes($: $T, keys?: string[]): Promise<Note[]> {
  const mine = (keys ?? (await $.store.keys())).filter(k => k.startsWith('krew:notes:'))
  const lists = await Promise.all(mine.map(k => $.store.get(k) as Promise<Note[] | undefined>))
  return lists.flatMap(l => l ?? []).sort((a, b) => a.at - b.at)
}

export function emptyLeadState(): LeadState {
  return {
    briefs: [],
    swaps: [],
    queue: [],
    groups: {},
    mode: 'steady',
    muted: false,
    dismissed: [],
    drills: [],
    merged: [],
    digestHours: ['11', '16'],
  }
}

export async function readLeadState($: $T): Promise<LeadState> {
  const v = (await $.store.get(KEY.leadState)) as Partial<LeadState> | undefined
  return { ...emptyLeadState(), ...(v ?? {}) }
}

export async function writeLeadState($: $T, s: LeadState): Promise<void> {
  await $.store.set(KEY.leadState, {
    ...s,
    briefs: s.briefs.slice(-40),
    swaps: s.swaps.slice(-40),
    queue: s.queue.slice(-40),
    dismissed: s.dismissed.slice(-300),
    drills: s.drills.slice(-20),
    merged: s.merged.slice(-200),
  })
}

/** One completion; resolves the text or null, never throws. */
export async function ask($: $T, model: string, system: string, prompt: string, maxTokens = 900): Promise<string | null> {
  try {
    const r = await $.model.complete({ model, system, prompt, maxTokens, timeoutMs: 60_000 })
    return r.isAnswered ? r.text : null
  } catch {
    return null
  }
}

export async function askJson<T>($: $T, model: string, system: string, prompt: string, maxTokens = 900): Promise<T | null> {
  const text = await ask($, model, system + '\nReply with one JSON object and nothing else.', prompt, maxTokens)
  return text ? parseJsonLoose<T>(text) : null
}

export async function run($: $T, argv: string[], cwd?: string, timeoutMs = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs })
    return { ok: r.exitCode === 0, out: r.stdout, err: r.stderr }
  } catch (error) {
    return { ok: false, out: '', err: String(error) }
  }
}

export type GitInfo = { root: string; common: string; repo: string; branch: string }

const gitCache = new Map<string, { at: number; info: GitInfo | null }>()

export async function gitInfo($: $T, dir: string): Promise<GitInfo | null> {
  const now = await $.clock.now()
  const hit = gitCache.get(dir)
  if (hit && now - hit.at < 60_000) return hit.info
  const r = await run($, ['git', 'rev-parse', '--show-toplevel', '--git-common-dir', '--abbrev-ref', 'HEAD'], dir, 5000)
  let info: GitInfo | null = null
  if (r.ok) {
    const [root, commonRaw, branch] = r.out.trim().split('\n')
    const common = commonRaw.startsWith('/') ? commonRaw : `${root}/${commonRaw}`
    const origin = await run($, ['git', 'config', '--get', 'remote.origin.url'], dir, 5000)
    const repo = origin.ok
      ? origin.out.trim().replace(/\.git$/, '').replace(/^.*[:/]([^/]+\/[^/]+)$/, '$1')
      : root.split('/').pop() ?? root
    info = { root, common: common.replace(/\/\.git\/?$/, ''), repo, branch }
  }
  gitCache.set(dir, { at: now, info })
  return info
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : '/'
}

/** Sessions the CLI knows: `claude agents --json`. */
export type CliAgent = { sessionId: string; name?: string; status?: string; cwd?: string; kind?: string; pid?: number }

export async function cliAgents($: $T): Promise<CliAgent[]> {
  const r = await run($, ['claude', 'agents', '--json'], undefined, 15_000)
  if (!r.ok) return []
  try {
    const list = JSON.parse(r.out) as CliAgent[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export async function home($: $T): Promise<string> {
  return (await $.env.get('HOME')) ?? ''
}
