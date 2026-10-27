const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${s}\x1b[${close}m` : s)

export const dim = wrap(2, 22)
export const bold = wrap(1, 22)
export const red = wrap(31, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const cyan = wrap(36, 39)
