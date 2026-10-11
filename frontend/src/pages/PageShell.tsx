import type { ReactNode } from 'react'
import { linkProps, useRoute } from '../router'
import ScreeningFooter from '../components/ScreeningFooter'
import '../hazards.css'
import './pages.css'

const NAV = [['/explore', 'Explore'], ['/backtest', 'Backtest'], ['/methods', 'Methods'], ['/about', 'About']] as const

export default function PageShell({ children }: { children: ReactNode }) {
  const route = useRoute()
  return (
    <div className="page">
      <a className="skip" href="#main">Skip to content</a>
      <header className="page-nav">
        <a className="logo" {...linkProps('/')}><span className="logo-globe" aria-hidden /> EarthOS</a>
        <nav>
          {NAV.map(([to, label]) => (
            <a key={to} {...linkProps(to)} aria-current={route === to ? 'page' : undefined}>{label}</a>
          ))}
        </nav>
      </header>
      <main id="main" tabIndex={-1}>{children}</main>
      <footer className="page-foot">
        <ScreeningFooter />
        <span>Data: NASA GIBS, MODIS, HLS and POWER; ESA WorldCover; Terrain Tiles (USGS, NOAA and others).</span>
        <span><a {...linkProps('/methods')}>Methods</a> · <a {...linkProps('/about')}>About</a></span>
      </footer>
    </div>
  )
}
