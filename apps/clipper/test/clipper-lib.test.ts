import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'
import { prepareDocumentForDefuddle } from '../src/lib/dom-prep'
import { detectBrowserName, parseConnectionCode, sha256Base64Url, toBase64Url } from '../src/lib/pkce'

describe('clipper PKCE and connection code helpers', () => {
  it('computes RFC 7636 SHA-256 base64url code challenge', async () => {
    // Standard test vector: SHA256("abc") -> ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=
    const challenge = await sha256Base64Url('abc')
    expect(challenge).toBe('ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0')
  })

  it('round-trips UTF-8 stetpad1 connection codes and rejects invalid inputs', () => {
    const payload = { url: 'http://127.0.0.1:27182', token: 'clp_secret123', mode: 'local' }
    const bytes = new TextEncoder().encode(JSON.stringify(payload))
    const code = 'stetpad1:' + toBase64Url(bytes)

    expect(parseConnectionCode(code)).toEqual({
      url: 'http://127.0.0.1:27182',
      token: 'clp_secret123',
      mode: 'local',
    })
    expect(parseConnectionCode('bad:abc')).toBeNull()
    expect(parseConnectionCode('stetpad1:not-json')).toBeNull()
    expect(
      parseConnectionCode(
        'stetpad1:' + toBase64Url(new TextEncoder().encode(JSON.stringify({ url: 'javascript:alert(1)', token: 'clp_1', mode: 'local' }))),
      ),
    ).toBeNull()
    expect(
      parseConnectionCode(
        'stetpad1:' + toBase64Url(new TextEncoder().encode(JSON.stringify({ url: 'http://127.0.0.1:27182', token: 'bad', mode: 'local' }))),
      ),
    ).toBeNull()
  })

  it('rejects hosted-web connection codes', () => {
    const payload = { url: 'https://writer.example.com', token: 'clp_secret123', mode: 'web' }
    const code = 'stetpad1:' + toBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
    expect(parseConnectionCode(code)).toBeNull()
  })

  it('detects browser names from user agents', () => {
    expect(detectBrowserName('Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36')).toBe('Chrome 浏览器')
    expect(detectBrowserName('Mozilla/5.0 Gecko/20100101 Firefox/132.0')).toBe('Firefox 浏览器')
    expect(detectBrowserName('Mozilla/5.0 AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15')).toBe('Safari 浏览器')
    expect(detectBrowserName('Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0')).toBe('Edge 浏览器')
  })
})

describe('prepareDocumentForDefuddle', () => {
  it('hydrates lazy images, resolves relative URLs, and removes hidden injection nodes without mutating original DOM', () => {
    const { document } = parseHTML(
      '<!doctype html><html><body>' +
        '<article>' +
        '<a href="/docs/guide">Guide</a>' +
        '<img src="data:image/svg+xml,<svg/>" data-src="/media/photo.webp">' +
        '<p>Clean content<span style="display:none">PROMPT INJECTION</span></p>' +
        '<div hidden>Secret</div>' +
        '</article>' +
        '</body></html>',
    )
    const prepared = prepareDocumentForDefuddle(document as unknown as Document, 'https://example.com/blog/post')
    const link = prepared.querySelector('a')!
    const img = prepared.querySelector('img')!

    expect(link.getAttribute('href')).toBe('https://example.com/docs/guide')
    expect(img.getAttribute('src')).toBe('https://example.com/media/photo.webp')
    expect(prepared.body.textContent).not.toContain('PROMPT INJECTION')
    expect(prepared.body.textContent).not.toContain('Secret')
    // Original DOM untouched
    expect(document.querySelector('a')!.getAttribute('href')).toBe('/docs/guide')
    expect(document.body.textContent).toContain('PROMPT INJECTION')
  })
})
