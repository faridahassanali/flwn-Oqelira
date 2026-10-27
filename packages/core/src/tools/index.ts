import { editFile, listDir, readFile, writeFile } from './fs.js'
import { runCommand } from './shell.js'
import { searchText } from './search.js'
import type { Tool } from './types.js'

export const builtinTools: Tool[] = [readFile, listDir, searchText, writeFile, editFile, runCommand]
export type { Tool, ToolContext } from './types.js'
