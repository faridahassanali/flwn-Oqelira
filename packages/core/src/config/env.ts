import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Only these prefixes are taken from .env files, so a project's unrelated secrets never enter our process. */
const ALLOWED = /^(FOUNDRY_|OQELIRA_|FLWN_|DATA_|TAVILY_API_KEY$)/

/**
 * A project's own ./.env is untrusted: a cloned repo could set FOUNDRY_BASE_URL and receive the key you configured
 * elsewhere, or steer the model, or point OQELIRA_ENV at another file. So it may only choose among deployments on your
 * own resource. Connection settings and keys come from the real environment, --env-file, $OQELIRA_ENV or ~/.oqelira/.env.
 */
const PROJECT_ALLOWED = /^(OQELIRA_MODEL|OQELIRA_MODELS_JSON|OQELIRA_EMBEDDING_DEPLOYMENT|FOUNDRY_MODELS|FOUNDRY_VARIANTS)$/

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Precedence (highest first): real environment, --env-file, $OQELIRA_ENV,
 * ~/.oqelira/.env, ./.env (restricted, see PROJECT_ALLOWED). Returns the files that were actually read.
 */
export function loadEnvFiles(opts: { explicit?: string; cwd: string; onIgnored?: (file: string, keys: string[]) => void }): string[] {
  if (process.env.OQELIRA_NO_ENV_FILES) return []
  const candidates = [
    opts.explicit,
    process.env.OQELIRA_ENV,
    path.join(os.homedir(), '.oqelira', '.env'),
    path.join(opts.cwd, '.env'),
  ].filter((p): p is string => Boolean(p))
  const used: string[] = []
  for (const file of candidates) {
    let text: string
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch {
      continue
    }
    used.push(file)
    const projectFile = file !== opts.explicit && file === path.join(opts.cwd, '.env')
    const ignored: string[] = []
    for (const [k, v] of Object.entries(parseEnv(text))) {
      if (!ALLOWED.test(k)) continue
      if (projectFile && !PROJECT_ALLOWED.test(k)) { ignored.push(k); continue }
      if (process.env[k] === undefined) process.env[k] = v
    }
    if (ignored.length) opts.onIgnored?.(file, ignored) // names only, never values
  }
  return used
}
