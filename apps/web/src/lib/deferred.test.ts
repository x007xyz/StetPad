import { expect, it } from 'vitest'
import { deferred } from './deferred.test-utils'

it('allows independent requests to finish in reverse order', async () => {
  const a = deferred<string>()
  const b = deferred<string>()
  const order: string[] = []
  const results = Promise.all([a.promise.then((v) => order.push(v)), b.promise.then((v) => order.push(v))])
  b.resolve('B')
  await b.promise
  expect(order).toEqual(['B'])
  a.resolve('A')
  await results
  expect(order).toEqual(['B', 'A'])
})
it('can resolve an empty response', async () => {
  const request = deferred<void>()
  request.resolve()
  await expect(request.promise).resolves.toBeUndefined()
})
it('can reject a response', async () => {
  const request = deferred<never>()
  const result = expect(request.promise).rejects.toThrow('offline')
  request.reject(new Error('offline'))
  await result
})
