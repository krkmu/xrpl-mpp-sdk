/**
 * Shared demo logging utility.
 * All demo scripts import from here -- no raw console.log in demos.
 */
import pc from 'picocolors'

// -- Timestamp --

function ts(): string {
  const d = new Date()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  const s = String(d.getSeconds()).padStart(2, '0')
  return pc.dim(`${h}:${m}:${s}`)
}

// -- Box drawing --

/**
 * Max content width inside a box before lines get word-wrapped. Sized so
 * that single tx-hash entries (indent + label + 64-char hash) still fit
 * on one line, while long prose (e.g. an LLM's reasoning) gets folded.
 */
const BOX_MAX_WIDTH = 84

/**
 * Word-wrap a single line to `width` visible columns, preserving any
 * leading indentation on the continuation lines so list-style entries
 * stay aligned. Lines without spaces longer than `width` (e.g. tx
 * hashes) are returned as-is rather than hard-split.
 */
function wrapLine(line: string, width: number): string[] {
  if (stripAnsi(line).length <= width) return [line]

  const indentMatch = line.match(/^(\s*)/)
  const indent = indentMatch ? indentMatch[1] : ''
  const words = line.trim().split(/\s+/)

  const out: string[] = []
  let current = indent
  for (const word of words) {
    const candidate = current === indent ? `${indent}${word}` : `${current} ${word}`
    if (stripAnsi(candidate).length > width && current !== indent) {
      out.push(current)
      current = `${indent}${word}`
    } else {
      current = candidate
    }
  }
  if (current !== '') out.push(current)
  return out.length > 0 ? out : [line]
}

export function box(lines: string[]): void {
  const wrapped = lines.flatMap((l) => wrapLine(l, BOX_MAX_WIDTH))
  const maxLen = Math.max(...wrapped.map((l) => stripAnsi(l).length))
  const inner = maxLen + 4 // 2 spaces padding each side
  const top = `\u250c${'─'.repeat(inner)}\u2510`
  const bot = `\u2514${'─'.repeat(inner)}\u2518`
  console.log(top)
  for (const line of wrapped) {
    const visLen = stripAnsi(line).length
    const right = maxLen - visLen
    console.log(`\u2502  ${line}${' '.repeat(right)}  \u2502`)
  }
  console.log(bot)
}

function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences are control chars by definition
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}

// -- Tagged log helpers --

export function loading(msg: string): void {
  console.log(`${ts()}  ${pc.dim('[..]')}  ${pc.dim(msg)}`)
}

export function wallet(label: string, address: string): void {
  console.log(`${ts()}  ${pc.green('[$]')}  ${label}: ${pc.green(address)}`)
}

export function key(label: string, value: string): void {
  console.log(`${ts()}  ${pc.dim('[key]')} ${label}: ${pc.dim(value)}`)
}

export function server(msg: string): void {
  console.log(`${ts()}  ${pc.bold(pc.green('[>>>]'))} ${pc.bold(msg)}`)
}

export function request(method: string, path: string, detail?: string): void {
  const route = `${method} ${pc.cyan(path)}`
  const extra = detail ? `  ${pc.dim(detail)}` : ''
  console.log(`${ts()}  ${pc.cyan('[req]')} ${route}${extra}`)
}

export function challenge(msg: string): void {
  console.log(`${ts()}  ${pc.yellow('[402]')} ${pc.yellow(msg)}`)
}

export function response(status: number, msg: string): void {
  if (status < 400) {
    console.log(`${ts()}  ${pc.green('[<-]')}  ${pc.green(`${status}`)} ${msg}`)
  } else {
    console.log(`${ts()}  ${pc.yellow('[<-]')}  ${pc.yellow(`${status}`)} ${msg}`)
  }
}

export function verify(msg: string): void {
  console.log(`${ts()}  ${pc.dim('[chk]')} ${pc.dim(msg)}`)
}

export function success(msg: string): void {
  console.log(`${ts()}  ${pc.green('[ok]')}  ${pc.green(msg)}`)
}

export function tx(hash: string, explorer?: string): void {
  console.log(`${ts()}  ${pc.cyan('[tx]')}  ${pc.cyan(hash)}`)
  if (explorer) {
    console.log(`${ts()}        ${pc.dim(explorer)}`)
  }
}

export function error(msg: string): void {
  console.log(`${ts()}  ${pc.red('[err]')} ${pc.red(msg)}`)
}

export function fix(msg: string): void {
  console.log(`${ts()}  ${pc.yellow('[fix]')} ${pc.yellow(msg)}`)
}

export function info(msg: string): void {
  console.log(`${ts()}  ${pc.dim('[i]')}   ${msg}`)
}

export function separator(): void {
  console.log('')
}

export const EXPLORER_URL = 'https://testnet.xrpl.org/transactions/'

export function explorerLink(hash: string): string {
  return `${EXPLORER_URL}${hash}`
}
