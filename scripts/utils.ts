// tslint:disable interface-over-type-literal

export interface WeakMapLike<K, V> {
  get(key: K): V | undefined
  has(key: K): boolean
  set(key: K, value: V): this
}

export interface MapLike<K, V> extends WeakMapLike<K, V> {
  [Symbol.iterator](): IterableIterator<[K, V]>
  entries(): IterableIterator<[K, V]>
  keys(): IterableIterator<K>
  values(): IterableIterator<V>
  clear(): void
}

type MapType<M, K, V> = M extends MapLike<any, any> ? MapLike<K, V> : WeakMapLike<K, V>
type ArgumentTypes<F extends Function> = F extends (...args: infer A) => any ? A : never
type Addtion<M extends WeakMapLike<any, any>, F extends Function> = {
  readonly map: MapType<M, ArgumentTypes<F>[0], F extends (...args: any[]) => any ? ReturnType<F> : unknown>,
}

export interface AbstractMapMapper<M extends WeakMapLike<any, any>> {
  <F extends () => any>(fn: F): ((key: any) => ReturnType<F>) & Addtion<M, F>
  <F extends Function>(fn: F): F & Addtion<M, F>
}

export function defineMapper<M extends WeakMapLike<any, any>>(createMap: () => M) {
  function createMapper(fn: Function): Function {
    const map = createMap()
    function getOrCreateItem(key: unknown) {
      if (map.has(key)) return map.get(key)
      const item = fn(key)
      map.set(key, item)
      return item
    }
    getOrCreateItem.map = map
    return getOrCreateItem
  }

  return createMapper as AbstractMapMapper<M>
}

export const createMapMapper = defineMapper(() => new Map())

export type MapMapper = typeof createMapMapper

export const createWeakMapMapper = defineMapper(() => new WeakMap())

export type WeakMapMapper = typeof createWeakMapMapper

export const cached = createWeakMapMapper(<F extends Function>(fn: F) => createCachedFn(fn))

interface CacheMapNode {
  value?: unknown
  weakmap: WeakMap<{}, CacheMapNode>
  map: Map<unknown, CacheMapNode>
}

interface CreateCachedFnOptions {
  respectThis?: boolean
}

export function createCachedFn<F extends Function>(fn: F, options?: CreateCachedFnOptions) {
  const { respectThis = false } = options || {}
  const root: CacheMapNode = {
    weakmap: new WeakMap(),
    map: new Map(),
  }
  function cachedFn(this: unknown, ...args: Array<unknown>) {
    let node = root
    for (const arg of respectThis ? [this, ...args] : args) {
      const map = typeof arg === 'object' && arg || typeof arg === 'function' ? node.weakmap : node.map
      let next = map.get(arg as object)
      if (!next) {
        next = {
          weakmap: new WeakMap(),
          map: new Map(),
        }
        map.set(arg as object, next)
      }
      node = next
    }
    if ('value' in node) {
      return node.value
    }
    return (node.value = respectThis ? fn.apply(this, args) : fn(...args))
  }
  function clear(this: unknown, ...args: Array<unknown>) {
    let node = root
    for (const arg of respectThis ? [this, ...args] : args) {
      const map = typeof arg === 'object' && arg || typeof arg === 'function' ? node.weakmap : node.map
      const next = map.get(arg as object)
      if (!next) return
      node = next
    }
    if ('value' in node) {
      delete node.value
    }
  }
  cachedFn.clear = clear
  return (cachedFn as Function) as F & { clear: typeof clear }
}
