import { editFile, listDir, readFile, writeFile } from './fs.js'
import { runCommand } from './shell.js'
import { searchText } from './search.js'
import { changeTools } from './change-tools.js'
import type { Tool } from './types.js'

export const builtinTools: Tool[] = [readFile, listDir, searchText, ...changeTools, writeFile, editFile, runCommand]
export type { Tool, ToolContext } from './types.js'
export { webSearch, webTools } from './web.js'
export { memoryTools } from './memory.js'
