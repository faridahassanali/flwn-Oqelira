import assert from 'node:assert/strict'
import { test } from 'node:test'
import { plainText } from '../src/safe-text.js'

const E = String.fromCharCode(27)
const c = (...codes: number[]) => String.fromCharCode(...codes)

test('plainText removes escape sequences and control characters that spoof a terminal', () => {
  assert.equal(plainText(`ok${E}[31mred${E}[0m`), 'okred') // colors
  assert.equal(plainText(`a${E}[2K${E}[1Ab`), 'ab') // erase line, cursor up: hides the previous line
  assert.equal(plainText(`a${E}[?25lb${E}[H`), 'ab') // hide cursor, home
  assert.equal(plainText(`x${E}]0;fake title${c(7)}y`), 'xy') // OSC title (BEL-terminated)
  assert.equal(plainText(`x${E}]8;;http://evil.example${E}\\click${E}]8;;${E}\\y`), 'xclicky') // OSC 8 hyperlink (ST-terminated)
  assert.equal(plainText(`safe\rfake`), 'safefake') // carriage return would overwrite the line
  assert.equal(plainText(`a${c(8)}b${c(127)}c${c(0)}d${c(0x9b)}e`), 'abcde') // backspace, DEL, NUL, C1
  assert.equal(plainText(`pay${E}`), 'pay') // a lone ESC
  assert.equal(plainText(`ab${E}[31`), 'ab') // truncated sequence at a chunk boundary leaves nothing dangerous
})

test('plainText removes invisible and reordering characters used to disguise text', () => {
  assert.equal(plainText(`rm${c(0x200b)} -rf`), 'rm -rf') // zero-width space
  assert.equal(plainText(`a${c(0x202e)}gnp.exe`), 'agnp.exe') // right-to-left override
  assert.equal(plainText(`a${c(0x2066)}b${c(0x2069)}`), 'ab') // isolates
  assert.equal(plainText(`a${c(0xfeff)}${c(0x2060)}b${c(0x2028)}${c(0x2029)}c`), 'abc')
})

test('plainText keeps real text: newlines, tabs, Unicode, Persian ZWNJ, RTL marks and emoji joiners', () => {
  const real = `line one\n\tindented\nمی${c(0x200c)}خواهم ${c(0x200f)}سلام\n👨${c(0x200d)}👩${c(0x200d)}👧 ✓ café 日本語`
  assert.equal(plainText(real), real)
})
