import { describe, expect, test } from 'claude-code/testing'

import { applyCompiled, draftBrief, renderBrief } from '../hooks/core/brief'
import { cleanName, decodeCtl, encodeCtl, globMatch, isMember, isPrUrl, parseTag, makeTag, rankNeeds, shellJoin, successorName } from '../hooks/core/util'
import { assess, decide, errorSignature, isCorrection, isTestCommand, newWitness, observe } from '../hooks/core/witness'

const call = (over: Partial<Parameters<typeof observe>[1]> = {}) => ({
  tool: 'Bash',
  key: 'npm test',
  isError: false,
  isEdit: false,
  isRead: false,
  isTest: true,
  isProgress: false,
  ...over,
})

describe('witness', () => {
  test('the same failing call three times counts as repetition', async () => {
    const w = newWitness()
    for (let i = 0; i < 3; i++) observe(w, call({ isError: true, errorText: 'Error: boom' }))
    expect(w.signals.repeats).toBeGreaterThanOrEqual(1)
  })

  test('the same error after fix attempts is a hard trigger', async () => {
    const w = newWitness()
    for (let i = 0; i < 3; i++) {
      observe(w, call({ isError: true, errorText: 'FAIL src/a.test.ts: expected 2 got 3' }))
      observe(w, call({ tool: 'Edit', key: `src/a.ts#${i}`, isEdit: true, isTest: false, file: '/r/src/a.ts' }))
    }
    observe(w, call({ isError: true, errorText: 'FAIL src/a.test.ts: expected 2 got 3' }))
    const v = assess(w.signals, 30, 0)
    expect(v.hard.some(h => h.includes('same error'))).toBe(true)
    expect(decide(v, 30, 50, false).action).toBe('swap')
  })

  test('a green test clears the failure memory', async () => {
    const w = newWitness()
    observe(w, call({ isError: true, errorText: 'Error: x' }))
    observe(w, call({ tool: 'Edit', key: 'e', isEdit: true, isTest: false, file: '/r/a.ts' }))
    observe(w, call({ isError: false }))
    expect(Object.keys(w.failSigs)).toHaveLength(0)
  })

  test('planned rotation needs a boundary and the threshold', async () => {
    const fresh = assess(newWitness().signals, 55, 0)
    expect(decide(fresh, 55, 50, true)).toEqual({ action: 'swap', planned: true })
    expect(decide(fresh, 55, 50, false).action).not.toBe('swap')
    expect(decide(assess(newWitness().signals, 20, 0), 20, 50, true).action).toBe('none')
  })

  test('two soft triggers ask for a judge, not a swap', async () => {
    const s = { ...newWitness().signals, repeats: 2, rereads: 2 }
    expect(decide(assess(s, 30, 0), 30, 50, false).action).toBe('judge')
  })

  test('error signatures ignore numbers and paths', async () => {
    expect(errorSignature('Error at /a/b.ts:12 expected 3')).toBe(errorSignature('Error at /c/d.ts:99 expected 7'))
  })

  test('corrections are recognised', async () => {
    expect(isCorrection("it's still broken")).toBe(true)
    expect(isCorrection('add a dark mode toggle')).toBe(false)
  })

  test('test commands are runners in command position, not the word "test" in a path', async () => {
    for (const c of ['npm test', 'npm run test -- auth', 'npx vitest run', 'cd app && pnpm test', 'go test ./...', 'cargo test', 'pytest -x', 'python -m pytest', 'make test', 'tsc --noEmit']) {
      expect(isTestCommand(c), c).toBe(true)
    }
    for (const c of ['cat src/a.test.ts', 'git commit -m "add test"', 'ls test/', 'grep -r test src', 'echo contest']) {
      expect(isTestCommand(c), c).toBe(false)
    }
  })
})

describe('util', () => {
  test('globs', async () => {
    expect(globMatch('src/auth/**', 'src/auth/login/a.ts')).toBe(true)
    expect(globMatch('src/*.ts', 'src/a/b.ts')).toBe(false)
    expect(globMatch('package-lock.json', 'package-lock.json')).toBe(true)
  })

  test('hire tags round-trip', async () => {
    const tag = makeTag({ name: 'Atlas II', gen: 2, area: 'src/**,docs/**' })
    const p = parseTag(`${tag}\nhello`)
    expect(p?.attrs.name).toBe('Atlas II')
    expect(p?.attrs.area).toBe('src/**,docs/**')
    expect(p?.rest).toBe('hello')
  })

  test('hire tags keep brackets inside quoted values', async () => {
    const tag = makeTag({ name: 'Nova', goal: 'fix the [auth] bug', area: 'src/[ab]/**' })
    const p = parseTag(`${tag}\nBrief body [see notes]`)
    expect(p?.attrs.goal).toBe('fix the [auth] bug')
    expect(p?.attrs.area).toBe('src/[ab]/**')
    expect(p?.rest).toBe('Brief body [see notes]')
    expect(parseTag('[krew:hire name="x"')).toBeNull()
    expect(parseTag('[krew:hireling]')).toBeNull()
  })

  test('agent names and tmux command lines are shell-safe', async () => {
    expect(cleanName('Atlas II')).toBe('Atlas II')
    expect(cleanName("ghost; rm -rf ~ $(id) `x`")).toBe('ghost rm -rf  id x'.replace(/\s+/g, ' '))
    expect(cleanName(undefined)).toBe('')
    expect(shellJoin(['claude', '-n', "O'Brien", 'line one\n$HOME `x`'])).toBe(`'claude' '-n' 'O'\\''Brien' 'line one\n$HOME \`x\`'`)
  })

  test('only GitHub PR links reach gh', async () => {
    expect(isPrUrl('https://github.com/kreative/app/pull/412')).toBe(true)
    expect(isPrUrl('--help')).toBe(false)
    expect(isPrUrl('https://github.com/kreative/app/pull/412 --rebase')).toBe(false)
  })

  test('crew membership is opt-in', async () => {
    expect(isMember('/work/app', ['/work/app'], false, '')).toBe(true)
    expect(isMember('/work/app/', ['/other', '/work/app/tmp/krew-atlas'], false, '')).toBe(true)
    expect(isMember('/work/app', ['/work/app-two'], false, '')).toBe(false)
    expect(isMember('/work/app', ['/elsewhere'], true, '')).toBe(true)
    expect(isMember('/work/app', ['/elsewhere'], false, 'Nova')).toBe(true)
    expect(isMember(undefined, ['/work/app'], false, '')).toBe(false)
    expect(isMember('/work/app', [undefined], false, '')).toBe(false)
  })

  test('control messages round-trip with their token', async () => {
    const c = decodeCtl(encodeCtl('tok', { op: 'freeze', swapId: 's1', reason: 'context 90%' }))
    expect(c).toMatchObject({ op: 'freeze', swapId: 's1', token: 'tok' })
  })

  test('successor names count up', async () => {
    expect(successorName('Atlas', 2)).toBe('Atlas II')
    expect(successorName('Atlas II', 3)).toBe('Atlas III')
  })

  test('inbox ranks risk first', async () => {
    const ranked = rankNeeds([
      { id: 'a', kind: 'question', text: 'q', risk: 1, at: 1 },
      { id: 'b', kind: 'stuck', text: 's', risk: 3, at: 5 },
    ])
    expect(ranked[0].id).toBe('b')
  })
})

describe('brief', () => {
  test('a compiled brief keeps only known assignees and renders every section', async () => {
    const b = applyCompiled(draftBrief('add login rate limiting', 0), {
      title: 'Rate-limit login',
      goal: 'Stop brute force on /login',
      criteria: ['5 attempts per minute per IP', 'returns 429'],
      area: ['src/auth/**'],
      doNotTouch: ['migrations/**'],
      verify: ['npm test'],
      assignees: ['Ghost', 'Atlas'],
      budgetUsd: 4,
    }, ['Atlas'])
    expect(b.status).toBe('pending')
    expect(b.assignees).toEqual(['Atlas'])
    const text = renderBrief(b)
    expect(text).toContain('## Acceptance criteria')
    expect(text).toContain('Do NOT touch')
    expect(text).toContain('$4.00')
  })
})
