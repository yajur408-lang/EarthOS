import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Fonts are self-hosted (bundled, font-display: swap): no render-blocking request to a third party, and no visitor
// IP sent to Google. Latin subsets only; they cover Spanish and the rest of Western Europe.
import '@fontsource/ibm-plex-sans/latin-400.css'
import '@fontsource/ibm-plex-sans/latin-500.css'
import '@fontsource/ibm-plex-sans/latin-600.css'
import '@fontsource/ibm-plex-mono/latin-400.css'
import '@fontsource/ibm-plex-mono/latin-500.css'
import '@fontsource/newsreader/latin-400.css'
import '@fontsource/newsreader/latin-500.css'
import './index.css'
import Root from './Root'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
