import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import '@fontsource-variable/bodoni-moda'
import '@fontsource-variable/literata'
import '@fontsource-variable/ibm-plex-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './index.css'
import App from './App'

// Offline-first, so fonts are bundled rather than fetched from a CDN.
const dark = !window.matchMedia('(prefers-color-scheme: light)').matches
document.documentElement.classList.toggle('dark', dark)

// Local review rows are the only irreplaceable data on this device (PLAN.md §2.5).
void navigator.storage?.persist?.()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
