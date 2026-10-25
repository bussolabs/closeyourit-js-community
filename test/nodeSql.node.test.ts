// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeDatabaseSql } from '../src/node/sql'

describe('bounded private SQL structure', () => {
  it('rejects ambiguous backslash modes instead of parsing private text as SQL', () => {
    for (const dialect of ['mysql', 'postgresql'] as const) {
      expect(
        normalizeDatabaseSql(String.raw`SELECT 'value\' FROM secret'`, dialect),
      ).toBeUndefined()
    }
  })

  it('rejects executable comments and bounds structure expansion', () => {
    expect(
      normalizeDatabaseSql('SELECT /*!80000 private */ 1', 'mysql'),
    ).toBeUndefined()
    expect(normalizeDatabaseSql('SELECT /*+ private */ 1', 'mysql')).toBeUndefined()
    expect(
      normalizeDatabaseSql(
        'SELECT ' + Array(1000).fill('column').join(','),
        'postgresql',
      ),
    ).toBeUndefined()
    expect(normalizeDatabaseSql(' -- only a comment', 'postgresql')).toBeUndefined()
  })

  it('retains subtraction structure while normalizing signed literals', () => {
    expect(normalizeDatabaseSql('SELECT 2-1, +3', 'postgresql')).toBe('SELECT ? - ?, ?')
  })

  it('redacts doubled quotes, Unicode strings and character set introducers', () => {
    expect(
      normalizeDatabaseSql(
        "SELECT 'private''value', U&'private', N'private'",
        'postgresql',
      ),
    ).toBe('SELECT ?, ?, ?')
    expect(normalizeDatabaseSql("SELECT _utf8mb4'private', N'private'", 'mysql')).toBe(
      'SELECT ?, ?',
    )
  })

  it('groups changed literals and placeholders without exposing identifiers or values', () => {
    const literal = normalizeDatabaseSql(
      "select email from private_customer where id = 42 and note = 'private-value'",
      'postgresql',
    )
    const bound = normalizeDatabaseSql(
      'SELECT email FROM private_customer WHERE id = $1 AND note = $2',
      'postgresql',
    )
    expect(literal).toBe(bound)
    expect(literal).toMatch(/^SELECT i_[a-p]{16} FROM i_[a-p]{16}/)
    expect(literal).not.toMatch(/email|private|\b42\b/i)
    expect(
      normalizeDatabaseSql(
        'SELECT email FROM other_customer WHERE id = 42',
        'postgresql',
      ),
    ).not.toBe(literal)
  })

  it('consumes quoted values before interpreting comment markers', () => {
    const result = normalizeDatabaseSql(
      "SELECT E'private\\\'value--/*', $tag$private/*value*/$tag$, $$private$$, X'abcd', 0x1234 /* private /* nested */ comment */ FROM \"private@example.test\" -- private-tail",
      'postgresql',
    )
    expect(result).toMatch(/^SELECT \?, \?, \?, \?, \? FROM i_[a-p]{16}$/)
    expect(result).not.toContain('private')
  })

  it('protects MySQL quoted identifiers, strings, names and comments', () => {
    const result = normalizeDatabaseSql(
      'SELECT `private-user@example.test`, "private-data" FROM `private_table` WHERE id=:private_bind AND note=? # private-comment',
      'mysql',
    )
    expect(result).not.toMatch(/private|example|table/i)
    expect(result).toContain('WHERE')
    expect(result).toContain(' = ?')
  })

  it.each([
    "SELECT 'unterminated-private",
    'SELECT $body$unterminated-private',
    'SELECT /* private',
    'SELECT "private',
    'SELECT `private',
    'SELECT 1; SELECT 2',
    'SELECT 😀',
    'SELECT ' + 'x'.repeat(32768),
  ])('fails closed for unsupported or incomplete input %s', (sql) => {
    expect(normalizeDatabaseSql(sql, 'postgresql')).toBeUndefined()
  })

  it('normalizes numbers, casts and trailing delimiters', () => {
    expect(
      normalizeDatabaseSql('SELECT -1.25e+3::numeric, TRUE, NULL;', 'postgresql'),
    ).toMatch(/^SELECT \? :: i_[a-p]{16}, TRUE, NULL$/)
  })
})
