import { editFile, listDir, readFile, writeFile } from './fs.js'
import { runCommand } from './shell.js'
import type { Tool } from './types.js'

export const builtinTools: Tool[] = [readFile, listDir, writeFile, editFile, runCommand]
export type { Tool, ToolContext } from './types.js'
