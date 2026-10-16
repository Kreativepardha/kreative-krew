// Kreative Krew: the type contract for $.state and the shared store.

export type Role = 'lead' | 'worker' | 'none'
export type AgentState = 'busy' | 'idle' | 'waiting' | 'frozen' | 'retiring'

export type NeedKind =
  | 'question'
  | 'approach'
  | 'pr'
  | 'blocked'
  | 'permission'
  | 'stuck'
  | 'rot'
  | 'budget'
  | 'conflict'
  | 'brief'
  | 'swap'
  | 'drill'

export type Need = {
  id: string
  kind: NeedKind
  text: string
  url?: string
  /** 0 info, 1 low, 2 medium, 3 high */
  risk: number
  at: number
  /** session id of the agent the need belongs to */
  sid?: string
  name?: string
  options?: string[]
  /** a reply Haiku pre-drafted for the human */
  draft?: string
  /** brief, swap or drill id this need points at */
  ref?: string
}

export type RepoTouch = { root: string; repo: string; branch: string; at: number; files: string[] }

export type Evidence = {
  reviewer?: string
  tests?: string
  goal?: string
  verdict: 'pending' | 'pass' | 'fail'
}

export type PrInfo = {
  url: string
  title?: string
  state?: string
  ci?: 'pass' | 'fail' | 'pending' | 'none'
  review?: string
  evidence?: Evidence
  at: number
}

export type Signals = {
  toolCalls: number
  toolErrors: number
  repeats: number
  pingPong: number
  rereads: number
  sameErrorFixes: number
  churn: number
  ruleBreaks: number
  invented: number
  redoAfterCompact: number
  corrections: number
  stallTurns: number
  compactions: number
  /** 0..1 canary quiz score, absent until run */
  canary?: number
  /** 0..1 fresh-eyes judge score, absent until run */
  judge?: number
}

export type Card = {
  sid: string
  name: string
  gen: number
  lineage: string[]
  state: AgentState
  task: string
  bullets: string[]
  needs: Need[]
  repos: RepoTouch[]
  prs: PrInfo[]
  contextPercent: number
  costUsd: number
  budgetUsd?: number
  sharpness: number
  hard: string[]
  signals: Signals
  mood: string
  area: string[]
  doNotTouch: string[]
  cwd: string
  worktree?: string
  branch?: string
  portBase?: number
  briefId?: string
  goal?: string
  turns: number
  startedAt: number
  lastActivityAt: number
  heartbeatAt: number
  lastProgressAt: number
  rotateReady?: boolean
  handoffReady?: string
  warm?: boolean
  predecessor?: string
  retiringAt?: number
  retiredReport?: string
  hiredVia?: 'bg' | 'tmux' | 'manual'
}

export type KEvent = { at: number; sid: string; name: string; kind: string; text: string; ref?: string }
export type Note = { at: number; sid: string; name: string; text: string }

export type BriefStatus = 'compiling' | 'pending' | 'sent' | 'rejected' | 'failed'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Brief = {
  id: string
  /** the human's raw words, kept as given */
  ask: string
  status: BriefStatus
  title: string
  /** the ask with its grammar fixed and stated clearly, same intent; the worker reads this, not `ask` */
  task?: string
  /** 3-8 expert roles, each with its article ("a lead product designer") */
  roles?: string[]
  /** plan: the deliverable is an HTML artifact with the complete plan, not code */
  kind?: 'build' | 'plan'
  /** `claude --effort` for a hired worker; absent keeps the CLI default */
  effort?: Effort
  goal: string
  context: string
  criteria: string[]
  area: string[]
  doNotTouch: string[]
  verify: string[]
  deadEnds: string[]
  outputFormat: string
  budgetUsd: number
  /** existing agent names, or empty with hireName set */
  assignees: string[]
  hireName?: string
  createdAt: number
  revisions: number
  error?: string
}

export type SwapStatus =
  | 'proposed'
  | 'freezing'
  | 'auditing'
  | 'spawning'
  | 'warming'
  | 'retiring'
  | 'done'
  | 'failed'
  | 'rejected'

export type Swap = {
  id: string
  fromSid: string
  fromName: string
  toName: string
  toSid?: string
  gen: number
  reason: string
  mode: 'planned' | 'emergency'
  status: SwapStatus
  at: number
  updatedAt: number
  disagreements?: string[]
  error?: string
}

export type HandoffFacts = {
  cwd: string
  branch?: string
  head?: string
  dirty: string[]
  lastTest?: string
  failures: string[]
  keyFiles: string[]
  prs: string[]
  costUsd: number
  contextPercent: number
}

export type HandoffAccount = {
  decisions: string[]
  deadEnds: string[]
  gotchas: string[]
  nextSteps: string[]
  openQuestions: string[]
  done: string[]
}

export type HandoffPacket = {
  id: string
  goal: string
  brief?: string
  facts: HandoffFacts
  account: HandoffAccount
  disagreements: string[]
  predecessor: { sid: string; name: string; reason: string }
  createdAt: number
}

export type QueueStatus = 'queued' | 'rebasing' | 'checking' | 'merged' | 'blocked'
export type QueueItem = { url: string; owner: string; status: QueueStatus; at: number; note?: string }

export type Conflict = { a: string; b: string; files: string[]; kind: 'merge' | 'overlap'; at: number }

export type StoryMode = 'focus' | 'steady' | 'war'

export type LeadState = {
  briefs: Brief[]
  swaps: Swap[]
  queue: QueueItem[]
  groups: Record<string, string[]>
  mode: StoryMode
  muted: boolean
  dismissed: string[]
  drills: { id: string; at: number; ackAt?: number; name: string }[]
  merged: { url: string; at: number; owner: string; costUsd: number }[]
  digestDay?: string
  digestHours: string[]
}

export type Board = {
  agents: Card[]
  offline: Card[]
  notes: Note[]
  events: KEvent[]
  inbox: Need[]
  conflicts: Conflict[]
  lead: LeadState
  burn: Record<string, number>
  updatedAt: number
}

export type Tab = 'inbox' | 'team' | 'radar' | 'money' | 'replay'

export type UiView = {
  tab: Tab
  detail: boolean
  replyTo?: string
  reviseId?: string
  replayAt: number
  replayAgent: string
  calm: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'kreative-krew': {
      board: Board
      view: UiView
      me: Card | null
      role: Role
    }
  }
}
