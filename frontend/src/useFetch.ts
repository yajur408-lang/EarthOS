import { useEffect, useState } from 'react'

/** Fetch helper keyed on its inputs; stale responses are ignored. */
export function useFetch<T>(key: string | null, load: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<{ key: string; data?: T; error?: string } | null>(null)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!key) return
    const ctrl = new AbortController()
    load(ctrl.signal)
      .then((data) => setState({ key, data }))
      .catch((e: Error) => !ctrl.signal.aborted && setState({ key, error: e.message }))
    return () => ctrl.abort()
  }, [key, nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  const cur = state && state.key === key ? state : null
  return { data: cur?.data ?? null, error: cur?.error ?? null, loading: !!key && !cur, retry: () => { setState(null); setNonce((n) => n + 1) } }
}
