// Parses `Error.stack` into Sentry-format frames (`stacktrace.frames`).
//
// Output order: from the oldest (bottom) to the most recent (top) —
// Sentry convention where `frames.last` is the crash point. The JS stack is
// newest-first, so it is reversed. Handles the V8/Chrome
// (`at fn (url:line:col)`) and Firefox/Safari (`fn@url:line:col`) formats.

export interface StackFrame {
  filename: string
  abs_path: string
  function?: string
  lineno?: number
  colno?: number
  in_app: boolean
}

// Defensive limit: very deep stacks do not bloat the payload.
const MAX_FRAMES = 50

/// Extracts the Sentry frames (oldest-first) from a textual stack, or `[]` if missing.
export function parseStack(stack: string | undefined): StackFrame[] {
  if (!stack) return []

  const frames: StackFrame[] = []
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const parsed = parseLine(line)
    if (parsed) frames.push(parsed)
  }

  // Stack newest-first → Sentry oldest-first, crash last.
  frames.reverse()
  if (frames.length > MAX_FRAMES) return frames.slice(frames.length - MAX_FRAMES)
  return frames
}

function parseLine(line: string): StackFrame | null {
  // V8/Chrome: "at fn (loc)" or "at loc".
  if (line.startsWith('at ')) {
    let rest = line.slice(3).trim()
    let fn: string | undefined
    const open = rest.indexOf('(')
    if (open !== -1 && rest.endsWith(')')) {
      fn = rest.slice(0, open).trim() || undefined
      rest = rest.slice(open + 1, -1).trim()
    }
    return frameFrom(rest, cleanFunction(fn))
  }

  // Firefox/Safari: "fn@loc" or "@loc".
  const at = line.lastIndexOf('@')
  if (at !== -1) {
    const fn = line.slice(0, at).trim() || undefined
    const loc = line.slice(at + 1).trim()
    return frameFrom(loc, cleanFunction(fn))
  }

  return null
}

function cleanFunction(fn: string | undefined): string | undefined {
  if (!fn) return undefined
  // Removes the uninformative V8 prefixes.
  const cleaned = fn.replace(/^(async|new)\s+/, '').trim()
  if (!cleaned || cleaned === '<anonymous>') return undefined
  return cleaned
}

function frameFrom(location: string, fn: string | undefined): StackFrame {
  const { url, line, col } = parseLocation(location)
  const frame: StackFrame = {
    filename: fileNameOf(url),
    abs_path: url,
    in_app: isInApp(url),
  }
  if (fn !== undefined) frame.function = fn
  if (line !== undefined) frame.lineno = line
  if (col !== undefined) frame.colno = col
  return frame
}

function parseLocation(loc: string): {
  url: string
  line?: number
  col?: number
} {
  const withColRow = loc.match(/^(.+):(\d+):(\d+)$/)
  if (withColRow) {
    return {
      url: withColRow[1]!,
      line: Number(withColRow[2]),
      col: Number(withColRow[3]),
    }
  }
  const withRow = loc.match(/^(.+):(\d+)$/)
  if (withRow) {
    return { url: withRow[1]!, line: Number(withRow[2]) }
  }
  return { url: loc }
}

function fileNameOf(url: string): string {
  const withoutQuery = url.split('?')[0]!.split('#')[0]!
  const segments = withoutQuery.split('/')
  const last = segments[segments.length - 1]
  return last && last.length > 0 ? last : url
}

function isInApp(url: string): boolean {
  if (!url) return false
  if (url === 'native' || url === '<anonymous>' || url === '[native code]') {
    return false
  }
  if (url.includes('node_modules')) return false
  return true
}
