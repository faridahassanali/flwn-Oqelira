import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { parseEnv } from '../packages/core/src/config/env.js'

const known: string[] = []
for (const file of ['.env', '.env.server']) {
  if (!fs.existsSync(file)) continue
  for (const [key,value] of Object.entries(parseEnv(fs.readFileSync(file,'utf8')))) if (/(KEY|TOKEN|PASSWORD|SECRET|DATABASE_URL)$/i.test(key) && value.length >= 12) known.push(value)
}
const files = execFileSync('git',['diff','--cached','--name-only','--diff-filter=ACMR','-z']).toString().split('\0').filter(Boolean)
let failed = false
for (const file of files) {
  if (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith('/.env.example') && file !== '.env.example') { console.error(`Refusing environment file: ${file}`); failed = true; continue }
  const content = execFileSync('git',['show',`:${file}`],{maxBuffer:20_000_000}).toString()
  if (known.some(value => content.includes(value)) || /-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16}/.test(content)) {
    console.error(`Potential secret in staged file: ${file}`); failed = true
  }
}
if (failed) process.exitCode = 1
else console.log(`PASS: ${files.length} staged files checked; no environment files, known local credentials or common key patterns found.`)
