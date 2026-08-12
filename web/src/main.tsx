import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import { establishSession } from './lib/session'

const rootEl = document.getElementById('root')
if (rootEl === null) {
  throw new Error('root element not found')
}

// Note: StrictMode disabled in dev because TerminalPanel's pty:spawn
// isn't idempotent under double-mount — the first pty gets killed
// and respawned, which is wasteful and confuses the agent launch
// sequence. Re-enable once the spawn cycle is StrictMode-safe.
// The server mints the cookie when the launch URL carries ?token=, so the
// bundle itself loads. This handles the leftovers: strip the token from the
// URL so it does not linger in history, and cover a deep link that arrives
// with a token after boot.
void establishSession().finally(() => {
  createRoot(rootEl).render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  )
})
