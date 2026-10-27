import readline from 'node:readline'

/**
 * Line reader that keeps lines even when nobody is asking yet (piped stdin delivers
 * everything at once), and reports EOF as `null`.
 */
export class LineReader {
  readonly rl: readline.Interface
  private queue: string[] = []
  private waiter: ((line: string | null) => void) | null = null
  private closed = false
  private readonly tty: boolean

  constructor(input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, private output = process.stdout) {
    this.tty = Boolean(input.isTTY)
    this.rl = readline.createInterface({ input, output, terminal: this.tty })
    this.rl.on('line', (line) => {
      if (this.waiter) {
        const w = this.waiter
        this.waiter = null
        w(line)
      } else this.queue.push(line)
    })
    this.rl.on('close', () => {
      this.closed = true
      if (this.waiter) {
        const w = this.waiter
        this.waiter = null
        w(null)
      }
    })
  }

  next(prompt: string): Promise<string | null> {
    // Piped (non-TTY) input: always print the prompt so the transcript reads naturally,
    // even when the answer was already waiting in the queue.
    if (!this.tty) this.output.write(prompt)
    const queued = this.queue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    if (this.closed) return Promise.resolve(null)
    if (this.tty) {
      this.rl.setPrompt(prompt)
      this.rl.prompt()
    }
    return new Promise((resolve) => {
      this.waiter = resolve
    })
  }

  close(): void {
    this.rl.close()
  }
}
