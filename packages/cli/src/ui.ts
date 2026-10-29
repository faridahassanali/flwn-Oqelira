import { plainText } from '@oqelira/core'

const enabled = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
// Content passes through plainText first, so model- or file-sourced text can never carry its own escape
// sequences; only the codes added here reach the terminal. Never nest one style helper inside another.
const wrap = (open: number, close: number) => (s: string) => (enabled ? `\x1b[${open}m${plainText(s)}\x1b[${close}m` : plainText(s))

export const dim = wrap(2, 22)
export const bold = wrap(1, 22)
export const red = wrap(31, 39)
export const green = wrap(32, 39)
export const yellow = wrap(33, 39)
export const cyan = wrap(36, 39)
