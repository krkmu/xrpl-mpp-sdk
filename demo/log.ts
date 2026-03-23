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

export function box(lines: string[]): void {
  const maxLen = Math.max(...lines.map((l) => stripAnsi(l).length))
  const inner = maxLen + 4 // 2 spaces padding each side
  const top = `\u250c${'─'.repeat(inner)}\u2510`
  const bot = `\u2514${'─'.repeat(inner)}\u2518`
  console.log(top)
  for (const line of lines) {
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
