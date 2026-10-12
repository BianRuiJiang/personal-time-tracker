import '@testing-library/jest-dom/vitest'

// Node 24 自带一个需要 --localstorage-file 的 localStorage，会盖掉 jsdom 的实现，
// 这里补一个内存版，让测试环境与真实浏览器一致。
if (typeof window !== 'undefined' && !window.localStorage) {
  const store = new Map<string, string>()
  const memoryStorage: Storage = {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
  Object.defineProperty(window, 'localStorage', { value: memoryStorage, configurable: true })
}
