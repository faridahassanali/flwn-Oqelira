import { plainText } from '@oqelira/core'

type Tone = 'cream' | 'navy' | 'ink' | 'soft' | 'green' | 'lavender' | 'gold' | 'salmon' | 'blue'
type Background = 'light' | 'dark'

// Synced from .agents/skills/flwn-design/palette/tokens.css. These are terminal
// RGB equivalents of the approved Flwn palette, not a second colour system.
const palette: Record<Tone, readonly [number, number, number]> = {
  cream: [247, 243, 234], navy: [0, 31, 85], ink: [20, 19, 26], soft: [107, 104, 117],
  green: [179, 227, 196], lavender: [227, 211, 250], gold: [248, 219, 153], salmon: [245, 179, 172], blue: [171, 225, 234],
}

function backgroundFrom(env: NodeJS.ProcessEnv): Background {
  const value = env.COLORFGBG?.split(';').at(-1)
  const code = value === undefined ? NaN : Number(value)
  // COLORFGBG uses 0-6 for dark terminal backgrounds and 7+ for light ones.
  return Number.isFinite(code) && code >= 7 ? 'light' : 'dark'
}

const rgb = (kind: 38 | 48, tone: Tone) => `${kind};2;${palette[tone].join(';')}`
const reset = '\x1b[0m'

export interface TerminalUi {
  bold(text: string): string
  dim(text: string): string
  red(text: string): string
  green(text: string): string
  yellow(text: string): string
  cyan(text: string): string
  wordmark(text?: string): string
  startupFrames(): string[]
  enabled: boolean
}

/** Build a UI palette that is readable on either a light or dark terminal. */
export function createTerminalUi(opts: { enabled: boolean; background?: Background } = { enabled: false }): TerminalUi {
  const enabled = opts.enabled
  const background = opts.background ?? 'dark'
  const foreground = background === 'light' ? 'navy' : 'cream'
  const muted = background === 'light' ? 'soft' : 'blue'
  const wrap = (open: string) => (text: string) => enabled ? `\x1b[${open}m${plainText(text)}${reset}` : plainText(text)
  const badge = (tone: Tone) => (text: string) => enabled ? `\x1b[${rgb(38, 'ink')};${rgb(48, tone)}m${plainText(text)}${reset}` : plainText(text)
  const wordmark = (text = 'flwn') => enabled ? `\x1b[1;${rgb(38, foreground)}m${plainText(text)}${reset}` : plainText(text)
  return {
    enabled,
    bold: wrap(`1;${rgb(38, foreground)}`),
    dim: wrap(rgb(38, muted)),
    red: badge('salmon'),
    green: badge('green'),
    yellow: badge('gold'),
    cyan: badge('blue'),
    wordmark,
    startupFrames: () => ['f   ', 'fl  ', 'flw ', 'flwn'].map(wordmark),
  }
}

const ui = createTerminalUi({ enabled: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR, background: backgroundFrom(process.env) })

export const { bold, dim, red, green, yellow, cyan } = ui
export const terminalEnabled = ui.enabled

/** Replace the live line immediately above the cursor; never emit ANSI in plain output. */
export function collapsePreviousLine(output: Pick<NodeJS.WriteStream, 'write'> = process.stdout): void {
  if (ui.enabled) output.write('\x1b[1A\r\x1b[2K')
}

/** A calm logo reveal. Never writes terminal control sequences to pipes or NO_COLOR output. */
export async function playStartup(output: Pick<NodeJS.WriteStream, 'write'> = process.stdout, terminal: Pick<TerminalUi, 'enabled' | 'startupFrames'> = ui): Promise<void> {
  if (!terminal.enabled) return
  for (const frame of terminal.startupFrames()) {
    output.write(`\r\x1b[2K${frame}`)
    await new Promise(resolve => setTimeout(resolve, 80))
  }
  output.write('\n')
}
