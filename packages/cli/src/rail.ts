/** Tracks the visual rail around one consecutive group of agent steps. */
export class StepRail {
  private openState = false

  begin(): string {
    if (this.openState) return '│  '
    this.openState = true
    return '┌─ '
  }

  item(): string { return this.openState ? '│  ' : '' }

  end(): string {
    if (!this.openState) return ''
    this.openState = false
    return '└─ '
  }

  get active(): boolean { return this.openState }
}
