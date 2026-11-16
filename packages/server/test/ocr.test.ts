import { createCanvas } from '@napi-rs/canvas'
import { describe, expect, it } from 'vitest'
import { fileToBlocks } from '../src/content'

/** A one-page PDF whose only content is an image: no text layer. */
function imagePdf(): Uint8Array {
  const c = createCanvas(40, 40)
  const g = c.getContext('2d')
  g.fillStyle = '#888'
  g.fillRect(0, 0, 40, 40)
  const jpg = c.toBuffer('image/jpeg')
  const parts: Buffer[] = []
  const offs: number[] = []
  let len = 0
  const add = (b: Buffer | string): void => {
    const buf = typeof b === 'string' ? Buffer.from(b, 'latin1') : b
    parts.push(buf)
    len += buf.length
  }
  add('%PDF-1.4\n')
  const obj = (n: number, body: Buffer | string): void => {
    offs[n] = len
    add(`${n} 0 obj\n`)
    add(body)
    add('\nendobj\n')
  }
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>')
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>')
  obj(4, Buffer.concat([Buffer.from(`<< /Type /XObject /Subtype /Image /Width 40 /Height 40 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`), jpg, Buffer.from('\nendstream')]))
  const content = 'q 200 0 0 200 0 0 cm /Im0 Do Q'
  obj(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  const xref = len
  add('xref\n0 6\n0000000000 65535 f \n' + [1, 2, 3, 4, 5].map((n) => String(offs[n]).padStart(10, '0') + ' 00000 n \n').join(''))
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`)
  return new Uint8Array(Buffer.concat(parts))
}

describe('scanned PDF import', () => {
  it('recognises text through the ocr callback, once per page, with PNG input', async () => {
    const calls: Uint8Array[] = []
    const blocks = await fileToBlocks('scan.pdf', imagePdf(), {
      ocr: async (png) => {
        calls.push(png)
        return '# 标题\n\n第一段文字\n\n- 要点一\n- 要点二'
      },
    })
    expect(calls).toHaveLength(1)
    expect(Array.from(calls[0]!.slice(1, 4))).toEqual([0x50, 0x4e, 0x47])
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'bulletItem', 'bulletItem'])
  })
  it('explains itself when no model can read images', async () => {
    await expect(fileToBlocks('scan.pdf', imagePdf())).rejects.toThrow('没有文字层')
  })
})
