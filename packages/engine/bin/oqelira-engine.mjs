#!/usr/bin/env node
// Launcher: registers tsx so we can run the TypeScript sources directly (no build step yet).
import { register } from 'tsx/esm/api'

register()
await import('../src/main.ts')
