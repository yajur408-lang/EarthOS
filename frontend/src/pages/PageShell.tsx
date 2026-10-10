import type { ReactNode } from 'react'
import { linkProps } from '../router'
import ScreeningFooter from '../components/ScreeningFooter'
import '../hazards.css'
import './pages.css'

export default function PageShell({ children }: { children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-nav">
        <a className="logo" {...linkProps('/')}><span className="logo-globe" aria-hidden /> EarthOS</a>
        <nav>
          <a {...linkProps('/explore')}>Explore</a>
          <a {...linkProps('/backtest')}>Backtest</a>
          <a {...linkProps('/methods')}>Methods</a>
          <a {...linkProps('/about')}>About</a>
        </nav>
      </header>
      <main>{children}</main>
      <footer className="page-foot">
        <ScreeningFooter />
        <span>Data: NASA GIBS, MODIS, HLS and POWER; ESA WorldCover; Terrain Tiles (USGS, NOAA and others).</span>
        <span><a {...linkProps('/methods')}>Methods</a> · <a {...linkProps('/about')}>About</a></span>
      </footer>
    </div>
  )
}
