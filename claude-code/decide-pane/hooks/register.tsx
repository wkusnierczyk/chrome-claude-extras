import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Question, QuestionState } from '../types'

const PANE = 'decide'
const TITLE = 'Questions'
// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const questions = atom({ plugin: 'decide-pane', key: 'questions' } as const, [], {
  shape: 'questions-1',
})
const refresh = atom(
  { plugin: 'decide-pane', key: 'refresh' } as const,
  { isRunning: false, error: '', at: 0 },
  { shape: 'refresh-1' },
)
const showAnswered = atom({ plugin: 'decide-pane', key: 'showAnswered' } as const, false)
// Set once the pane was opened unasked, so a reload does not reopen a pane
// the person closed.
const isPaneShown = atom({ plugin: 'decide-pane', key: 'isPaneShown' } as const, false)

const STATES: QuestionState[] = ['open', 'progressing', 'answered']
const HEADINGS: Record<QuestionState, string> = {
  open: 'Open',
  progressing: 'Progressing',
  answered: 'Answered',
}
const MAX_ANSWER = 8000

function ask(previous: Question[], answer: string): string {
  return [
    '[decide-pane: a side question; it is not shown to the user, so answer only as asked.]',
    '',
    'List every question you, the assistant, have asked the user in this session: a question in a reply,',
    'an AskUserQuestion prompt, a pick asked of a mock-up or text simulation, a go-ahead asked for.',
    'Not questions the user asked, and not rhetorical ones. One entry per decision: a question asked again',
    'is one entry; a reply that asked three separate things is three entries.',
    '',
    'State, from the user\'s replies since it was asked:',
    '- open: no reply yet, or put off ("later", "let me think");',
    '- progressing: answered in part, or the answer raised a follow-up only the user can settle;',
    '- answered: settled.',
    '',
    'Your reply that ended the last turn, which may not appear above:',
    '<<<',
    answer.length > MAX_ANSWER ? answer.slice(-MAX_ANSWER) : answer,
    '>>>',
    '',
    'The list as it stood (keep these numbers; a new question takes the next number):',
    JSON.stringify(previous),
    '',
    'Answer with a JSON array and nothing else, one object per question, in the order first asked:',
    '{"n": number, "issue": "#16", "PR #80", "owner/repo#5" or "", "question": one or two standalone',
    'sentences with the options when there were some, "state": "open" | "progressing" | "answered",',
    '"note": for progressing what is still missing, for answered the answer in a few words, else "",',
    '"link": a mock-up or artifact URL the question points to, or ""}',
  ].join('\n')
}

// The reply's JSON array: tried from each `[` in turn, since the fork may
// lead with prose that holds one.
function parse(text: string): Question[] | undefined {
  const end = text.lastIndexOf(']')
  for (let start = text.indexOf('['); start >= 0 && start < end; start = text.indexOf('[', start + 1)) {
    let raw: unknown
    try {
      raw = JSON.parse(text.slice(start, end + 1))
    } catch {
      continue
    }
    if (!Array.isArray(raw)) continue

    return toQuestions(raw)
  }

  return undefined
}

function toQuestions(raw: unknown[]): Question[] {
  const seen = new Set<number>()
  const list: Question[] = []
  for (const q of raw) {
    if (typeof q !== 'object' || q === null) continue
    const item = q as Record<string, unknown>
    if (typeof item.question !== 'string') continue
    let n = typeof item.n === 'number' && Number.isInteger(item.n) && item.n > 0 ? item.n : 0
    if (n === 0 || seen.has(n)) n = Math.max(0, ...seen) + 1
    seen.add(n)
    list.push({
      n,
      issue: typeof item.issue === 'string' ? item.issue : '',
      question: item.question,
      state: STATES.includes(item.state as QuestionState) ? (item.state as QuestionState) : 'open',
      note: typeof item.note === 'string' ? item.note : '',
      link: typeof item.link === 'string' ? item.link : '',
    })
  }

  return list
}

// Where the Chrome extension's native host reads each session's list: one
// file per session, so several sessions never write the same file.
// Writes go one after another, in the order asked, so a session's end mark
// is never overwritten by a refresh that was already writing.
let writes: Promise<void> = Promise.resolve()

function publish($: EngineInterface, isEnded: boolean, endedId?: string): Promise<void> {
  writes = writes.then(() => write($, isEnded, endedId))

  return writes
}

async function write($: EngineInterface, isEnded: boolean, endedId?: string): Promise<void> {
  try {
    const home = await $.env.get('HOME')
    if (home === undefined || home === '') return
    const sessionId = endedId ?? (await $.session.id())
    const repo = await $.session.repo()
    const status = await read($, refresh)
    // The Remote Control id, as claude.ai/code's address has it: how the
    // extension finds the session a page shows. Absent without Remote Control.
    const bridge = await $.env.get('CLAUDE_CODE_BRIDGE_SESSION_ID')
    const doc = {
      sessionId,
      bridgeSessionId: bridge === undefined || bridge === '' ? null : bridge,
      root: await $.session.root(),
      repo: repo?.remote ?? null,
      updatedAt: await $.clock.now(),
      isEnded,
      error: status.error,
      questions: await read($, questions),
    }
    await $.fs.write(`${home}/.claude/decide-pane/sessions/${sessionId}.json`, JSON.stringify(doc, null, 2))
  } catch (err) {
    $.ui.log(`could not write the session's questions: ${String(err)}`)
  }
}

// The last turn's answer, kept for a refresh the person asks for. Module
// variables start over on a reload, so a run cut short by one never sticks.
let lastAnswer = ''
let isRunning = false
let isQueued = false
// Bumped by /clear: a run that began before it drops its result.
let generation = 0

async function run($: EngineInterface): Promise<void> {
  if (isRunning) {
    isQueued = true
    return
  }
  isRunning = true
  const started = generation
  await update($, refresh, r => ({ ...r, isRunning: true }))
  let error = ''
  try {
    const previous = await read($, questions)
    const reply = await $.model.fork({ prompt: ask(previous, lastAnswer) })
    if (started !== generation) {
      error = ''
    } else if (!reply.isAnswered) {
      error = reply.reason === 'nothing-to-fork' ? '' : `not updated: ${reply.reason}`
    } else {
      const list = parse(reply.text)
      if (list === undefined) error = 'not updated: the reply was not a list'
      else await update($, questions, () => list)
    }
  } finally {
    isRunning = false
    const at = await $.clock.now()
    await update($, refresh, () => ({ isRunning: false, error, at }))
    if (started === generation) await publish($, false)
  }
  if (isQueued) {
    isQueued = false
    await run($)
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'questions',
      description: 'Show the questions this session has asked you, in a pane',
    })
    await update($, refresh, r => ({ ...r, isRunning: false }))
    if (!(await read($, isPaneShown))) {
      await update($, isPaneShown, () => true)
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // First, before anything awaits: a refresh begun before the end must not
    // publish after the end mark.
    generation += 1
    await publish($, true, e.sessionId)
    if (e.reason === 'clear') {
      // The process goes on as a new session, with no session.start.
      lastAnswer = ''
      isQueued = false
      await update($, questions, () => [])
      await update($, refresh, () => ({ isRunning: false, error: '', at: 0 }))
      // A record for the new session at once, so the page does not go on
      // showing the cleared one until the first reply.
      await publish($, false)
    }

    return next(e)
  })

  on('command.run', { command: 'questions' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    const surfaces = (await $.session.surfaces()).join(', ') || 'none'
    if (opened.isPlaced) return { text: `Questions pane opened (surfaces: ${surfaces}).` }

    return { text: `Questions pane is open but not drawn: ${opened.reason} (surfaces: ${surfaces}).` }
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && e.reason === 'answer') {
      lastAnswer = e.answer
      // Off the turn's dispatch, so the turn ends without waiting on the fork.
      $.clock.after(0, () => void run($))
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, questions)
    const status = await read($, refresh)
    const isShowingAnswered = await read($, showAnswered)
    const width = Math.max(20, e.props.bodyColumns)

    const byState = (state: QuestionState) => list.filter(q => q.state === state)
    const counts = STATES.map(s => `${HEADINGS[s]} ${byState(s).length}`).join(' · ')

    const row = (q: Question) => (
      <Button
        key={`q${q.n}`}
        plain
        onPress={() => $.prompt.fill({ text: `Q${q.n}: `, mode: 'insert' })}
      >
        <Text bold>Q{q.n}</Text>
        {q.issue !== '' && <Text dimColor> {q.issue}</Text>} {q.question}
        {q.state === 'progressing' && q.note !== '' && <Text color="yellow"> — still: {q.note}</Text>}
        {q.state === 'answered' && q.note !== '' && <Text dimColor> — {q.note}</Text>}
        {q.link !== '' && <Text dimColor> {q.link}</Text>}
      </Button>
    )

    return (
      <Box flexDirection="column" width={width}>
        <Box>
          <Text dimColor>{counts} </Text>
          <Button key="refresh" label={status.isRunning ? 'Updating…' : 'Refresh'} onPress={() => run($)} />
        </Box>
        {status.error !== '' && <Text color="red">{status.error}</Text>}
        {list.length === 0 && (
          <Text dimColor>{status.isRunning ? 'Reading the session…' : 'No questions yet.'}</Text>
        )}
        {(['open', 'progressing'] as const).map(
          state =>
            byState(state).length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>
                  {HEADINGS[state]} ({byState(state).length})
                </Text>
                {byState(state).map(row)}
              </Box>
            ),
        )}
        {byState('answered').length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Button
              key="answered"
              plain
              onPress={() => update($, showAnswered, v => !v)}
            >
              <Text bold>
                {isShowingAnswered ? '▾' : '▸'} Answered ({byState('answered').length})
              </Text>
            </Button>
            {isShowingAnswered && byState('answered').map(row)}
          </Box>
        )}
      </Box>
    )
  })
}
