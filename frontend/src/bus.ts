import { useEffect, useState } from 'react'

/**
 * A tiny value store for high-frequency state (cursor position, camera pose).
 * Only components that subscribe re-render, instead of the whole app on every frame.
 */
export interface Bus<T> {
  get: () => T
  set: (v: T) => void
  subscribe: (listener: (v: T) => void) => () => void
}

export function createBus<T>(initial: T): Bus<T> {
  let value = initial
  const listeners = new Set<(v: T) => void>()
  return {
    get: () => value,
    set(v) {
      value = v
      listeners.forEach((l) => l(v))
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export function useBus<T>(bus: Bus<T>): T {
  const [value, setValue] = useState(bus.get)
  useEffect(() => bus.subscribe(setValue), [bus])
  return value
}
