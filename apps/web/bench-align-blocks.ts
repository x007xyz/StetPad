import { createHash } from 'node:crypto'
import { chromium } from '@playwright/test'
import type { RichBlock } from './src/api'

const block = (blockId: string): RichBlock => ({
  blockId, type: 'paragraph', text: 'This is paragraph ' + blockId, attrs: {}, delta: [{ insert: 'This is paragraph ' + blockId }],
})

function inputs(size: number, different: boolean): [RichBlock[], RichBlock[]] {
  const before = Array.from({ length: size }, (_, i) => block('p' + i))
  if (different) return [before, Array.from({ length: size }, (_, i) => block('new' + i))]
  const after = before.flatMap((b, i) => {
    if (i % 101 === 23) return []
    if (i % 97 === 31) return [block('extra' + i), structuredClone(b)]
    if (i % 41 === 13) return [{ ...b, text: b.text + ' (edited)', delta: [{ insert: b.text + ' (edited)' }] }]
    return [structuredClone(b)]
  })
  return [before, after]
}

const browserUrl = process.argv[2]
const browser = browserUrl ? await chromium.launch({ args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] }) : undefined
const page = await browser?.newPage()
try {
  if (page && browserUrl) {
    await page.goto(browserUrl)
    await page.evaluate(async () => {
      const moduleUrl = '/src/panels/DiffView.tsx'
      const { alignBlocks } = await import(moduleUrl)
      Object.assign(globalThis, { alignBlocks })
    })
  }
  const nodeAlign = page ? undefined : (await import('./src/panels/DiffView')).alignBlocks
  for (const [scenario, sizes] of [['scattered edits', [20, 500, 2000, 4000, 8000]], ['different IDs', [500, 2000, 4000, 8000]]] as const) {
    for (const size of sizes) {
      const [a, b] = inputs(size, scenario === 'different IDs')
      const batch = size === 20 ? 500 : size === 500 ? 5 : 1
      const samples: number[] = []
      const memory: number[] = []
      let output = ''
      for (let run = -2; run < 7; run++) {
        let duration: number
        let bytes: number
        if (page) {
          ;({ duration, bytes, output } = await page.evaluate(({ a, b, batch }) => {
            const env = globalThis as typeof globalThis & { gc: () => void; alignBlocks: typeof import('./src/panels/DiffView').alignBlocks; performance: { memory: { usedJSHeapSize: number } } }
            env.gc()
            const startBytes = env.performance.memory.usedJSHeapSize
            const start = performance.now()
            let rows
            for (let i = 0; i < batch; i++) rows = env.alignBlocks(a, b)
            const duration = (performance.now() - start) / batch
            return { duration, bytes: env.performance.memory.usedJSHeapSize - startBytes, output: JSON.stringify(rows) }
          }, { a, b, batch }))
        } else if (nodeAlign) {
          globalThis.gc?.()
          const heap = () => { const { heapUsed, arrayBuffers } = process.memoryUsage(); return heapUsed + arrayBuffers }
          const startBytes = heap()
          const start = performance.now()
          let rows
          for (let i = 0; i < batch; i++) rows = nodeAlign(a, b)
          duration = (performance.now() - start) / batch
          bytes = heap() - startBytes
          output = JSON.stringify(rows)
        } else {
          throw new Error('Alignment module was not loaded')
        }
        if (run >= 0) {
          samples.push(duration)
          memory.push(bytes / 1024 ** 2)
        }
      }
      const median = (values: number[]) => values.sort((a, b) => a - b)[3]!
      console.log(JSON.stringify({ scenario, size, rightSize: b.length, batch, ms: median(samples), mib: median(memory), sha256: createHash('sha256').update(output).digest('hex') }))
    }
  }
} finally {
  await browser?.close()
}
