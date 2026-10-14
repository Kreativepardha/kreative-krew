// Kreative Krew: one mod, two roles. The session named in the store is the
// Manager; every other session that loads the mod is a worker.

import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'

import { NO_CARD, NO_ROLE, PANE, emptyBoard, initialView, runtime } from './core/atoms'
import { applyOptions } from './core/io'
import { answerLeadTool, COMMANDS, LEAD_SECTION, poll, refreshRole, registerLead, registerLeadTools, runCommand } from './lead'
import { hintTail, leadBand, spinnerWord, toolCard, workerBand } from './ui/chrome'
import { renderPane, type Els } from './ui/pane'
import {
  answerWorkerTool,
  flushCard,
  heartbeat,
  onPromptSubmit,
  registerWorker,
  registerWorkerTools,
  startWorker,
  TOOL,
  workerSection,
} from './worker'

const boardAtom = atom({ plugin: 'kreative-krew', key: 'board' } as const, emptyBoard())
const meAtom = atom({ plugin: 'kreative-krew', key: 'me' } as const, NO_CARD)
const roleAtom = atom({ plugin: 'kreative-krew', key: 'role' } as const, NO_ROLE)
const viewAtom = atom({ plugin: 'kreative-krew', key: 'view' } as const, initialView())

const WORKER_TOOLS = ['krew_board', 'krew_note', 'ask_manager', 'krew_handoff', 'krew_warmup_done', 'ask_predecessor', 'krew_retire_ready']

export const register: Register = (on, options) => {
  applyOptions(options)
  registerLead(on)
  registerWorker(on)

  on('session.start', async ($, e, next) => {
    await startWorker($)
    await registerWorkerTools($)
    await registerLeadTools($)
    for (const c of COMMANDS) await $.command.register(c)
    await refreshRole($)
    $.clock.every(5000, () => {
      void poll($)
      void flushCard($).catch(() => undefined)
    })
    $.clock.every(60_000, () => void heartbeat($).catch(() => undefined))
    if (runtime.role === 'lead') void $.ui.open({ id: PANE, title: 'Krew' })
    return next(e)
  })

  for (const c of COMMANDS) {
    on('command.run', { command: c.name }, async ($, e) => ({ text: await runCommand($, e.command, e.args) })).catch(() => ({ text: 'Kreative Krew: that command failed. Run claude --debug for details.' }))
  }

  for (const name of WORKER_TOOLS) {
    on('tool.call', { tool: new RegExp(`^${TOOL(name)}$`) }, async ($, e) => answerWorkerTool($, name, e as unknown as Record<string, unknown>)).catch(() => ({ isError: true as const, result: 'Kreative Krew: the tool failed.' }))
  }
  on('tool.call', { tool: new RegExp(`^${TOOL('krew_brief')}$`) }, async ($, e) => answerLeadTool($, 'krew_brief', e as unknown as Record<string, unknown>)).catch(() => ({ isError: true as const, result: 'Kreative Krew: the brief failed.' }))

  on('prompt.submit', async ($, e, next) => {
    const r = await onPromptSubmit($, e.text, e.origin.kind === 'composer').catch(() => null)
    if (!r || (r.text === e.text && r.context.length === 0)) return next(e)
    return next({ ...e, text: r.text, context: [...(e.context ?? []), ...r.context] })
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const text = runtime.role === 'lead' ? LEAD_SECTION : workerSection()
    if (!text) return r
    return { sections: [...r.sections.filter(s => s.id !== 'kreative-krew'), { id: 'kreative-krew', text, scope: 'session' }] }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e) as Els
    const role = await read($, roleAtom)
    if (role !== 'lead') {
      return <E.Text dimColor>This session is not the Manager. Run /krew-lead to manage the crew from here.</E.Text>
    }
    const board = await read($, boardAtom)
    const view = await read($, viewAtom)
    return renderPane(E, $, board, view, Math.max(40, e.props.bodyColumns), e.props.scroll.bodyRows || e.viewport?.rows || 30, await $.clock.now())
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const role = await read($, roleAtom)
    const E = $.ui.resolve(e) as Els
    const board = await read($, boardAtom)
    if (role === 'lead') {
      const view = await read($, viewAtom)
      return leadBand(E, $, board, view, e.props.bodyColumns)
    }
    const me = await read($, meAtom)
    if (role === 'worker' && me) return workerBand(E, me, board) ?? next(e)
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const tail = hintTail(await read($, roleAtom), await read($, boardAtom), await read($, meAtom))
    return tail ? next({ ...e, props: { ...e.props, tail } }) : next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if ((await read($, roleAtom)) !== 'lead') return next(e)
    const word = spinnerWord(await read($, boardAtom))
    return word ? next({ ...e, props: { ...e.props, word } }) : next(e)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!e.props.tool.startsWith('mcp__kreative-krew__')) return next(e)
    const card = toolCard($.ui.resolve(e) as Els, e.props.tool, e.props.output, e.props.isErrored)
    return card ?? next(e)
  })
}
