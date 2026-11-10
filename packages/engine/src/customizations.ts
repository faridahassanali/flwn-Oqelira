import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryDir } from '@oqelira/core'

export type HookEvent = 'session_start' | 'session_end' | 'before_tool' | 'after_tool'
export interface CustomCommand { name: string; description: string; prompt: string }
export interface Hook { id: string; event: HookEvent; command: string; tool?: string; timeoutSeconds?: number }
interface Customizations { commands: CustomCommand[]; hooks: Hook[] }

const EMPTY: Customizations = { commands: [], hooks: [] }
const NAME = /^[a-z][a-z0-9-]{0,31}$/
const EVENTS = new Set<HookEvent>(['session_start', 'session_end', 'before_tool', 'after_tool'])

function parse(value: unknown): Customizations {
  if (!value || typeof value !== 'object') return EMPTY
  const data = value as { commands?: unknown; hooks?: unknown }
  const commands = Array.isArray(data.commands) ? data.commands.filter((command): command is CustomCommand => Boolean(
    command && typeof command === 'object' && NAME.test((command as CustomCommand).name) &&
    typeof (command as CustomCommand).description === 'string' && (command as CustomCommand).description.length <= 160 &&
    typeof (command as CustomCommand).prompt === 'string' && (command as CustomCommand).prompt.trim() && (command as CustomCommand).prompt.length <= 20_000,
  )) : []
  const hooks = Array.isArray(data.hooks) ? data.hooks.filter((hook): hook is Hook => Boolean(
    hook && typeof hook === 'object' && NAME.test((hook as Hook).id) && EVENTS.has((hook as Hook).event) &&
    typeof (hook as Hook).command === 'string' && (hook as Hook).command.trim() && (hook as Hook).command.length <= 2_000 &&
    ((hook as Hook).tool === undefined || typeof (hook as Hook).tool === 'string') &&
    ((hook as Hook).timeoutSeconds === undefined || Number.isInteger((hook as Hook).timeoutSeconds) && (hook as Hook).timeoutSeconds! >= 1 && (hook as Hook).timeoutSeconds! <= 300),
  )) : []
  return { commands, hooks }
}

function load(file: string): Customizations {
  try { return parse(JSON.parse(fs.readFileSync(file, 'utf8'))) } catch { return EMPTY }
}

/** Trusted local customizations. A cloned repository is never read as a source of hooks or commands. */
export function openCustomizations(cwd: string, stateRoot = path.join(os.homedir(), '.oqelira')) {
  const files = { user: path.join(stateRoot, 'customizations.json'), project: path.join(memoryDir(cwd, stateRoot), 'customizations.json') }
  const user = load(files.user), project = load(files.project)
  const byName = new Map<string, CustomCommand>()
  for (const command of [...user.commands, ...project.commands]) byName.set(command.name, command)
  const commands = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  const hooks = [...user.hooks, ...project.hooks]
  return {
    files,
    commands: () => commands,
    hasToolHooks: () => hooks.some((hook) => hook.event === 'before_tool' || hook.event === 'after_tool'),
    hooksFor: (event: HookEvent, tool?: string) => hooks.filter((hook) => hook.event === event && (!hook.tool || hook.tool === tool)),
    expand(name: string, args: string) { const command = byName.get(name); return command ? command.prompt.replaceAll('{{args}}', args) : undefined },
  }
}
