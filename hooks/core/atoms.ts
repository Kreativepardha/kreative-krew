// Session-local values the drawings read; the store holds what sessions share.

import type { Board, Card, Role, UiView } from '../../types'
import { emptyLeadState } from './io'

export const PLUGIN = 'kreative-krew'
export const PANE = 'krew'

export function emptyBoard(): Board {
  return {
    agents: [],
    offline: [],
    notes: [],
    events: [],
    inbox: [],
    conflicts: [],
    lead: emptyLeadState(),
    burn: {},
    updatedAt: 0,
  }
}

export function initialView(): UiView {
  return { tab: 'inbox', detail: false, replayAt: -1, replayAgent: '', calm: true }
}

export const NO_CARD = null as Card | null
export const NO_ROLE = 'none' as Role

/** The role this process last resolved; drawings read `roleAtom`. */
export const runtime = {
  role: 'none' as Role,
  sid: '',
  token: '',
}
