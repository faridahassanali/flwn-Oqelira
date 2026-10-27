import { searchWorkspace } from './search-engine.mjs'
import type { Tool } from './types.js'
import { str } from './types.js'
export const searchText: Tool = {
  spec: {
    name: 'search_text',
    description: 'Search literal text in project files and return paths, 1-based lines and matching text. Hidden, credential, dependency and generated paths, symlinks, binary and large files are excluded. Narrow the path when results are limited.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string', description: 'Project-relative file or directory; default is root.' }, case_sensitive: { type: 'boolean' }, max_results: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['query'] },
  },
  risk: 'read',
  describe: input => `search project for ${str(input, 'query')}`,
  run: (input, ctx) => searchWorkspace(ctx.cwd, input, ctx.signal),
}
