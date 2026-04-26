import { render } from 'preact'
import './index.css'
import { App } from './app.tsx'
import { loadSettings } from './lib/settings'

// Load settings before rendering
loadSettings().then(() => {
  render(<App />, document.getElementById('app')!)
})
