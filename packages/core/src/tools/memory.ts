import { MAX_MEMORY_CHARS } from '../memory/gateway.js'
import type { ContextGateway } from '../memory/gateway.js'
import { optNum, str, truncate } from './types.js'
import type { Tool } from './types.js'

/** Project memory tools. They live in the control process, never in the sandboxed worker. */
export function memoryTools(gateway: ContextGateway): Tool[] {
  return [
    {
      spec: {
        name: 'recall_memory',
        description: 'Search saved project memory (decisions, conventions, facts from earlier chats) by meaning. Returns ranked notes with ids.',
        parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] },
      },
      risk: 'read',
      describe: (i) => `recall memory: ${str(i, 'query')}`,
      async run(input, ctx) {
        const limit = optNum(input, 'limit') ?? 5
        if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('"limit" must be an integer from 1 to 10')
        const hits = await gateway.recall(str(input, 'query'), { limit, signal: ctx.signal })
        return truncate(hits.length ? hits.map((h) => `[${h.id.slice(0, 8)}] (${h.score.toFixed(2)}) ${h.text}`).join('\n') : 'No matching memory.')
      },
    },
    {
      spec: {
        name: 'save_memory',
        description: `Save one durable fact about this project for future chats (a decision and why, a convention, a gotcha). Max ${MAX_MEMORY_CHARS} characters. Never save secrets, credentials or personal data.`,
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      risk: 'write',
      describe: (i) => `save memory: ${str(i, 'text').slice(0, 120)}`,
      async run(input) {
        const entry = await gateway.remember(str(input, 'text'))
        return `Saved memory ${entry.id.slice(0, 8)}.`
      },
    },
    {
      spec: {
        name: 'forget_memory',
        description: 'Delete a saved memory by the id shown in recall_memory.',
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      },
      risk: 'write',
      describe: (i) => `forget memory ${str(i, 'id')}`,
      async run(input) {
        return (await gateway.forget(str(input, 'id'))) ? 'Forgotten.' : 'No memory with that id.'
      },
    },
  ]
}
