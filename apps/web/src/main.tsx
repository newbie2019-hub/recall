import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
// Offline-first, so fonts are bundled rather than fetched from a CDN.
import '@fontsource-variable/bodoni-moda'
import '@fontsource-variable/literata'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './index.css'
// Applies the stored choice on import, which has to happen here rather than in
// a component: a theme decided after first paint is a flash of the wrong one.
import '@/lib/theme'
import App from './App'

// Local review rows are the only irreplaceable data on this device (PLAN.md §2.5).
void navigator.storage?.persist?.()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
