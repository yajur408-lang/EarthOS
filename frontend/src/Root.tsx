import { lazy, Suspense } from 'react'
import { useRoute } from './router'
import Landing from './pages/Landing'

// The explorer (3D globe) and the text pages load only when visited, so the landing page stays light.
const Explorer = lazy(() => import('./App.tsx'))
const Methods = lazy(() => import('./pages/Methods'))
const About = lazy(() => import('./pages/About'))
const Backtest = lazy(() => import('./pages/Backtest'))

function Boot() {
  return (
    <div className="boot" role="status">
      <div className="boot-globe" aria-hidden="true" />
      <b>EarthOS</b>
      <span>Loading…</span>
    </div>
  )
}

export default function Root() {
  const route = useRoute()
  return (
    <Suspense fallback={<Boot />}>
      {route === '/explore' ? <Explorer /> : route === '/methods' ? <Methods /> : route === '/about' ? <About /> : route === '/backtest' ? <Backtest /> : <Landing />}
    </Suspense>
  )
}
