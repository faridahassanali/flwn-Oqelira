export function foundryEndpoint(value: string): string {
  const url=new URL(value.trim())
  if(url.protocol!=='https:' || url.username || url.password || url.search || url.hash || !/\.(openai\.azure\.com|services\.ai\.azure\.com)$/.test(url.hostname) || (url.pathname!=='/' && url.pathname!=='/openai/v1' && url.pathname!=='/openai/v1/')) throw new Error('Use your HTTPS Azure Foundry endpoint or /openai/v1 base URL')
  return url.origin+'/openai/v1'
}
export function secretName(endpoint:string):string {return 'oqelira.foundry:'+new URL(endpoint).origin}

export interface Setup { endpoint:string; model:{id:string;deployment:string;api:'responses'|'chat';speed:string} }

/**
 * Credentials and model choice go to the engine through its environment, never through a file or an argument.
 * The engine is started with OQELIRA_NO_ENV_FILES, so a project's own .env cannot redirect the key.
 */
export function engineEnv(base: NodeJS.ProcessEnv, setup: Setup, key: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!/^(FOUNDRY_|OQELIRA_)/.test(k)) env[k] = v
  return {
    ...env,
    ELECTRON_RUN_AS_NODE: '1', // VS Code's own runtime acts as plain Node; the extension never needs a separate install
    FOUNDRY_BASE_URL: foundryEndpoint(setup.endpoint),
    FOUNDRY_KEY: key,
    OQELIRA_MODELS_JSON: JSON.stringify([setup.model]),
    OQELIRA_MODEL: setup.model.id,
    ...(base.OQELIRA_HOME ? { OQELIRA_HOME: base.OQELIRA_HOME } : {}),
    ...(base.OQELIRA_EMBEDDING_DEPLOYMENT ? { OQELIRA_EMBEDDING_DEPLOYMENT: base.OQELIRA_EMBEDDING_DEPLOYMENT } : {}),
    ...(base.TAVILY_API_KEY ? { TAVILY_API_KEY: base.TAVILY_API_KEY } : {}),
  }
}

/**
 * What the file would contain if an approved write or edit ran, for the native diff. undefined when the request
 * is not a file change (commands, memory, network) or cannot be previewed exactly.
 */
export function proposedContent(tool: string, input: unknown, before: string | null): string | null | undefined {
  const i = (input ?? {}) as Record<string, unknown>
  if ((tool === 'write_file' || tool === 'apply_file_change' || tool === 'revert_file_change') && (typeof i.content === 'string' || i.content === null)) return i.content
  if (tool === 'edit_file' && before !== null && typeof i.old_string === 'string' && typeof i.new_string === 'string' && i.old_string) {
    const at = before.indexOf(i.old_string)
    if (at < 0 || before.indexOf(i.old_string, at + 1) >= 0) return undefined // the tool will refuse an ambiguous edit
    return before.slice(0, at) + i.new_string + before.slice(at + i.old_string.length)
  }
  return undefined
}

/** Whether the engine can save a narrow rule for this tool; by tool name, matching the engine's own list. */
export const rememberable = (tool: string): boolean => tool === 'run_command' || tool === 'write_file' || tool === 'edit_file' || tool === 'apply_file_change'
