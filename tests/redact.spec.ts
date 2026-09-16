import { describe, expect, it } from 'vitest'
import { isSensitivePath, redactContentText, redactText, REDACTED } from '../src/client/redact.ts'

describe('isSensitivePath', () => {
  it('marks credential-shaped filenames', () => {
    expect(isSensitivePath('C:/proj/.env')).toBe(true)
    expect(isSensitivePath('config/secrets.yaml')).toBe(true)
    expect(isSensitivePath('~/auth/credentials.json')).toBe(true)
    expect(isSensitivePath('deploy/api-key.prod.yml')).toBe(true)
    expect(isSensitivePath('/home/u/.ssh/id_rsa')).toBe(true)
    expect(isSensitivePath('cert/server.pem')).toBe(true)
  })
  it('passes ordinary filenames', () => {
    expect(isSensitivePath('src/index.ts')).toBe(false)
    expect(isSensitivePath('docs/readme.md')).toBe(false)
    expect(isSensitivePath('package.json')).toBe(false)
  })
  it('does not mask files whose names merely CONTAIN a pattern inside a longer word', () => {
    expect(isSensitivePath('src/tokenizer.ts')).toBe(false)
    expect(isSensitivePath('config/dev.environment.ts')).toBe(false)
    expect(isSensitivePath('src/style.keys.ts')).toBe(false)
    expect(isSensitivePath('docs/api-tokens.md')).toBe(false)
  })
  it('still masks pattern matches at a word boundary', () => {
    expect(isSensitivePath('deploy/.env.local')).toBe(true)
    expect(isSensitivePath('app/mytoken.yaml')).toBe(true)
    expect(isSensitivePath('config/passwords.yml')).toBe(true)
  })
})

describe('redactContentText', () => {
  it('masks yaml secret assignments keeping the key name', () => {
    const out = redactContentText('name: demo\napi_key: sk-1234567890abcdef\nport: 8080')
    expect(out).toContain('name: demo')
    expect(out).toContain('api_key: ' + REDACTED)
    expect(out).toContain('port: 8080')
    expect(out).not.toContain('sk-1234567890abcdef')
  })
  it('masks quoted json fields and equals-style env lines', () => {
    expect(redactContentText('"password": "hunter2"')).toBe('"password": ' + REDACTED)
    expect(redactContentText('API_TOKEN=abcdef1234567890')).toBe('API_TOKEN=' + REDACTED)
  })
  it('masks bare credential tokens in free text', () => {
    const out = redactContentText('see sk-abcdefghijklmnop123456 and AKIAIOSFODNN7EXAMPLE')
    expect(out).not.toContain('sk-abcdefghijklmnop123456')
    expect(out).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(out).toContain(REDACTED)
  })
  it('masks bearer headers and PEM key headers', () => {
    expect(redactContentText('Authorization: Bearer abcdef1234567890abcd')).toContain(REDACTED)
    expect(redactContentText('-----BEGIN RSA PRIVATE KEY-----')).toBe(REDACTED)
  })
  it('leaves ordinary code untouched', () => {
    const code = 'const x = 42\nconsole.log("count", x)'
    expect(redactContentText(code)).toBe(code)
  })
  it('leaves generic bare-word assignments alone (key/auth/token/pass label ordinary content too)', () => {
    expect(redactContentText("key: 'ArrowUp'")).toBe("key: 'ArrowUp'")
    expect(redactContentText('--key: red')).toBe('--key: red')
    expect(redactContentText('token: a lexical unit')).toBe('token: a lexical unit')
    expect(redactContentText('auth: none')).toBe('auth: none')
  })
  it('still masks qualified secret field names', () => {
    expect(redactContentText('access_token: ghp_abcdefghijklmnopqrst')).toBe('access_token: ' + REDACTED)
    expect(redactContentText('client_secret: shhh-1234567890')).toBe('client_secret: ' + REDACTED)
  })
})

describe('redactText', () => {
  it('masks a whole sensitive file line-wise', () => {
    const out = redactText('/app/.env', 'USER=me\nTOKEN=abc\n\n# comment')
    expect(out.text).toBe(REDACTED + '\n' + REDACTED + '\n\n' + REDACTED)
    expect(out.hit).toBe(true)
  })
  it('reports hit=false for clean ordinary content', () => {
    const out = redactText('src/main.ts', 'export function main() {}')
    expect(out.hit).toBe(false)
    expect(out.text).toBe('export function main() {}')
  })
})
