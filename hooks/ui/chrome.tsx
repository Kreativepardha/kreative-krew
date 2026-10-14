// The calm layer: the band above the prompt, hint pills, spinner and cards.

import type { EngineInterface, RenderElement } from 'claude-code'

import type { Board, Card, Role, UiView } from '../../types'
import { PANE } from '../core/atoms'
import { short, usd } from '../core/util'
import type { Els } from './pane'

type $T = EngineInterface

const GLYPH: Record<string, string> = { busy: '●', waiting: '◆', idle: '○', frozen: '❄', retiring: '↘' }
const COLOR: Record<string, string> = { busy: 'success', waiting: 'warning', idle: 'subtle', frozen: 'suggestion', retiring: 'subtle' }

export function leadBand(E: Els, $: $T, board: Board, view: UiView, width: number): RenderElement {
  const { Box, Text, Button } = E
  const room = Math.max(1, Math.floor((width - 34) / 18))
  const shown = board.agents.slice(0, room)
  const more = board.agents.length - shown.length
  const urgent = board.inbox.filter(n => n.risk >= 2).length
  return (
    <Box justifyContent="space-between">
      <Text wrap="truncate-end">
        <Text bold color="claude">KREW </Text>
        {shown.length === 0 && <Text dimColor>no workers yet · /brief to start </Text>}
        {shown.map(a => (
          <Text key={`band-${a.sid}`}>
            <Text color={COLOR[a.state] ?? 'text'}>{GLYPH[a.state] ?? '•'}</Text>
            {a.name} <Text dimColor>{short(a.task, 10)} {a.contextPercent}% </Text>
          </Text>
        ))}
        {more > 0 && <Text dimColor>+{more} </Text>}
        {board.conflicts.length > 0 && <Text color="error">⚡{board.conflicts.length} </Text>}
      </Text>
      <Button
        key="band-open"
        label={board.inbox.length ? `${board.inbox.length} need you${urgent ? ` (${urgent}!)` : ''}` : 'dashboard'}
        variant={urgent ? 'primary' : 'secondary'}
        plain={urgent ? undefined : true}
        onPress={() => void $.ui.open({ id: PANE, title: 'Krew', focus: true })}
      />
    </Box>
  )
}

export function workerBand(E: Els, me: Card, board: Board): RenderElement | null {
  const { Text } = E
  const conflict = board.conflicts.find(c => c.a === me.name || c.b === me.name)
  const notable = me.state === 'frozen' || me.hard.length > 0 || !!conflict || me.gen > 1
  if (!notable) return null
  return (
    <Text wrap="truncate-end">
      <Text bold color="claude">KREW · {me.name}</Text>
      <Text dimColor> owns {short(me.area.join(', ') || 'its brief', 30)}</Text>
      {me.gen > 1 && <Text dimColor> · gen {me.gen}</Text>}
      {me.state === 'frozen' && <Text color="suggestion"> · ❄ handing off</Text>}
      {me.hard.length > 0 && <Text color="error"> · ⚠ {short(me.hard[0], 40)}</Text>}
      {conflict && <Text color="warning"> · ⚡ overlaps {conflict.a === me.name ? conflict.b : conflict.a}</Text>}
    </Text>
  )
}

export function hintTail(role: Role, board: Board, me: Card | null): string | undefined {
  if (role === 'lead') {
    const burn = Object.values(board.burn).reduce((s, b) => s + b, 0)
    const parts = [`${board.inbox.length} need you`, `${usd(burn)}/h`]
    if (board.conflicts.length) parts.push(`${board.conflicts.length} conflict${board.conflicts.length > 1 ? 's' : ''}`)
    return `KREW · ${parts.join(' · ')}`
  }
  if (role === 'worker' && me) {
    return `${me.name} · ctx ${me.contextPercent}% · ${usd(me.costUsd)}${me.budgetUsd ? `/${usd(me.budgetUsd)}` : ''} · sharp ${me.sharpness}`
  }
  return undefined
}

export function spinnerWord(board: Board): string | undefined {
  const busy = board.agents.filter(a => a.state === 'busy')
  if (busy.length === 0) return undefined
  return busy.length === 1 ? `Managing ${busy[0].name}` : `Managing ${busy[0].name} +${busy.length - 1}`
}

export function toolCard(E: Els, tool: string, output: unknown, isErrored: boolean): RenderElement | null {
  const { Box, Text } = E
  const text = typeof output === 'string' ? output : Array.isArray(output) ? output.map(o => (typeof o === 'object' && o && 'text' in o ? String((o as { text: unknown }).text) : '')).join('\n') : null
  if (!text) return null
  const name = tool.replace('mcp__kreative-krew__', '')
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={isErrored ? 'error' : 'claude'} paddingX={1}>
      <Text bold color={isErrored ? 'error' : 'claude'}>
        KREW · {name}
      </Text>
      {text
        .split('\n')
        .slice(0, 14)
        .map((line, i) => (
          <Text key={`l-${i}`} dimColor={line.startsWith('- ') === false && i > 0} wrap="truncate-end">
            {line}
          </Text>
        ))}
    </Box>
  )
}
