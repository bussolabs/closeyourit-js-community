import { createHash } from 'node:crypto'

export type DatabaseDialect = 'postgresql' | 'mysql'

// Only structural words survive. Identifiers are pseudonymous, never raw names.
const keywords = new Set(
  (
    'SELECT FROM WHERE AND OR NOT IN IS NULL TRUE FALSE JOIN LEFT RIGHT INNER OUTER ' +
    'FULL CROSS ON AS INSERT INTO VALUES UPDATE SET DELETE RETURNING LIMIT OFFSET ' +
    'ORDER BY GROUP HAVING ASC DESC DISTINCT ALL UNION INTERSECT EXCEPT WITH RECURSIVE ' +
    'CASE WHEN THEN ELSE END EXISTS BETWEEN LIKE ILIKE ESCAPE COLLATE CONFLICT DO ' +
    'NOTHING DEFAULT FOR SHARE SKIP LOCKED NOWAIT BEGIN START TRANSACTION COMMIT ' +
    'ROLLBACK SAVEPOINT RELEASE TO'
  ).split(' '),
)

/** A bounded structural fingerprint, not a SQL validator or executable statement. */
export function normalizeDatabaseSql(
  sql: string,
  dialect: DatabaseDialect,
): string | undefined {
  if (!sql.length || sql.length > 32768) return
  const tokens: string[] = []
  let cursor = 0
  let ended = false
  let outputSize = 0
  const append = (token: string): boolean => {
    outputSize += token.length + 1
    if (outputSize > 8192 || tokens.length >= 1024) return false
    tokens.push(token)
    return true
  }

  while (cursor < sql.length) {
    const rest = sql.slice(cursor)
    const whitespace = /^\s+/.exec(rest)
    if (whitespace) {
      cursor += whitespace[0].length
      continue
    }
    if (rest.startsWith('--') || (dialect === 'mysql' && rest[0] === '#')) {
      const newline = rest.indexOf('\n')
      cursor += newline < 0 ? rest.length : newline + 1
      continue
    }
    if (rest.startsWith('/*')) {
      // MySQL version comments execute SQL. Hints are intentionally unsupported too.
      if (rest[2] === '!' || rest[2] === '+') return
      cursor += 2
      let depth = 1
      while (cursor < sql.length && depth) {
        if (sql.startsWith('/*', cursor)) {
          if (dialect === 'mysql' || depth >= 32) return
          depth++
          cursor += 2
        } else if (sql.startsWith('*/', cursor)) {
          depth--
          cursor += 2
        } else cursor++
      }
      if (depth) return
      continue
    }
    if (ended) return
    if (rest[0] === ';') {
      ended = true
      cursor++
      continue
    }

    const dollar =
      dialect === 'postgresql' && /^(\$[a-z_][a-z0-9_]*\$|\$\$)/i.exec(rest)
    if (dollar) {
      const delimiter = dollar[0]
      const close = sql.indexOf(delimiter, cursor + delimiter.length)
      if (close < 0 || !append('?')) return
      cursor = close + delimiter.length
      continue
    }

    const prefix = /^(?:[ebxn]|u&|_[a-z0-9_]+)(?=')/i.exec(rest)
    const prefixSize = prefix?.[0].length ?? 0
    const quote = rest[prefixSize]
    if (quote === "'" || quote === '"' || quote === '`') {
      if (quote === '`' && dialect !== 'mysql') return
      const start = cursor + prefixSize
      cursor = start + 1
      let closed = false
      while (cursor < sql.length) {
        if (sql[cursor] === '\\') {
          // Session SQL modes are unknown. Only explicit PostgreSQL E strings
          // have unambiguous backslash escaping; otherwise omit the observation.
          if (dialect !== 'postgresql' || prefix?.[0].toUpperCase() !== 'E') return
          cursor += 2
          continue
        }
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2
            continue
          }
          closed = true
          break
        }
        cursor++
      }
      if (!closed) return
      const identifier = quote === '`' || (quote === '"' && dialect === 'postgresql')
      if (!append(identifier ? hashIdentifier(sql.slice(start + 1, cursor)) : '?'))
        return
      cursor++
      continue
    }

    const bind = /^(?:\$[0-9]+|:[a-z_][a-z0-9_]*|\?)/i.exec(rest)
    if (bind) {
      if (!append('?')) return
      cursor += bind[0].length
      continue
    }
    const number =
      /^(?:0[xob][a-f0-9_]+|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:e[+-]?[0-9_]+)?)/i.exec(
        rest,
      )
    if (number) {
      if (!append('?')) return
      cursor += number[0].length
      continue
    }
    const word = /^[a-z_][a-z0-9_$]*/i.exec(rest)
    if (word) {
      const upper = word[0].toUpperCase()
      if (!append(keywords.has(upper) ? upper : hashIdentifier(word[0].toLowerCase())))
        return
      cursor += word[0].length
      continue
    }
    const operator = /^(?:::|->>|->|<=|>=|<>|!=|\|\||&&|[-+*/%=<>(),.\[\]])/.exec(rest)
    if (!operator) return
    const token = operator[0]
    const previous = tokens[tokens.length - 1]
    const unary =
      (token === '+' || token === '-') &&
      (previous === undefined ||
        previous === '(' ||
        previous === ',' ||
        previous === '=' ||
        previous === 'SELECT' ||
        previous === 'THEN' ||
        previous === 'ELSE') &&
      /^(?:[0-9]|\.[0-9])/.test(rest.slice(1))
    if (!unary && !append(token)) return
    cursor += token.length
  }
  if (!tokens.length) return
  return tokens.join(' ').replace(/ ,/g, ',')
}

function hashIdentifier(value: string): string {
  // Alphabetic encoding survives the receiver's defensive numeric normalization.
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16)
  return `i_${digest.replace(/[0-9]/g, (digit) => String.fromCharCode(103 + Number(digit)))}`
}
