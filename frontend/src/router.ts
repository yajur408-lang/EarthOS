import { useEffect, useState } from 'react'

// Tiny client-side router: four pages don't need a library. The server returns index.html for every path.
export type Route = '/' | '/explore' | '/methods' | '/about'

const ROUTES: Route[] = ['/', '/explore', '/methods', '/about']

function current(): Route {
  const p = location.pathname.replace(/\/+$/, '') || '/'
  // Old share links were "/#lat=…" - they belong to the explorer.
  if (p === '/' && /(^|&)lat=/.test(location.hash.slice(1))) return '/explore'
  return (ROUTES as string[]).includes(p) ? (p as Route) : '/'
}

export function navigate(to: string) {
  history.pushState(null, '', to)
  window.dispatchEvent(new PopStateEvent('popstate'))
  document.querySelector('.page')?.scrollTo(0, 0)
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(current)
  useEffect(() => {
    const on = () => setRoute(current())
    window.addEventListener('popstate', on)
    return () => window.removeEventListener('popstate', on)
  }, [])
  return route
}

/** An <a> that navigates without a full page load (falls back to a normal link with modifier keys). */
export function linkProps(to: string) {
  return {
    href: to,
    onClick: (e: { preventDefault: () => void; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; button: number }) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
      e.preventDefault()
      navigate(to)
    },
  }
}
