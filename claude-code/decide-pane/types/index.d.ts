export type QuestionState = 'open' | 'progressing' | 'answered'

export type Question = {
  n: number
  issue: string
  question: string
  state: QuestionState
  note: string
  link: string
}

export type Refresh = { isRunning: boolean; error: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'decide-pane': {
      questions: Shaped<Question[]>
      refresh: Shaped<Refresh>
      showAnswered: boolean
      isPaneShown: boolean
    }
  }
}
