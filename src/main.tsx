import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

const f0017Params = new URLSearchParams(window.location.search)
const f0017Theme = f0017Params.get('f0017Theme')
if (import.meta.env.DEV && (f0017Theme === 'light' || f0017Theme === 'dark')) {
  localStorage.setItem('theme-storage', JSON.stringify({ state: { theme: f0017Theme, resolvedTheme: f0017Theme }, version: 0 }))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

const f0017CollectorPort = f0017Params.get('f0017Tauri')
if (import.meta.env.DEV && f0017CollectorPort) {
  void import('./bench/f0017Tauri').then(module => module.startF0017TauriBenchmark(f0017CollectorPort))
}
