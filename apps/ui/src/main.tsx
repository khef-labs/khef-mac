import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { loadSettings } from './lib/settings'
import { clearNavContext } from './lib/navContext'

// Hard / soft reloads should reset the in-memory list nav context. The
// stored ids+order can become stale (e.g. when a project's slide_order
// metadata changes between captures), and users have no clean way to
// recover other than closing the tab. Treat any reload as the user asking
// for fresh state. SPA navigations (clicks, history.back) keep navContext
// because performance.navigation.type stays at its original 'navigate'.
const navEntry = performance.getEntriesByType('navigation')[0] as
  | PerformanceNavigationTiming
  | undefined
if (navEntry?.type === 'reload') {
  clearNavContext()
}

// Load settings before rendering
loadSettings().then(() => {
  render(<App />, document.getElementById('app')!)
})
