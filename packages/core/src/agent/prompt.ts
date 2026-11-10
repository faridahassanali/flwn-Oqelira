import fs from 'node:fs'

/** Replaced with the file's text by esbuild `define` in bundled builds (the VS Code extension); undefined under tsx/node. */
declare const __OQELIRA_SYSTEM_PROMPT__: string | undefined

/** system-prompt.txt is the single source of truth. A missing or empty file is a startup error, never a silent default. */
function loadSystemPrompt(): string {
  let text: string
  if (typeof __OQELIRA_SYSTEM_PROMPT__ === 'string') {
    text = __OQELIRA_SYSTEM_PROMPT__
  } else {
    const file = new URL('./system-prompt.txt', import.meta.url)
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error(`Oqelira cannot start: system prompt file is missing or unreadable (${file.pathname}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  text = text.trim()
  if (!text) throw new Error('Oqelira cannot start: the system prompt file is empty')
  return text
}

export const DEFAULT_SYSTEM = loadSystemPrompt()
