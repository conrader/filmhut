/**
 * Exchange the launch token for a session cookie.
 *
 * The server is default-deny. `scripts/start.sh` prints a URL carrying
 * `?token=…`, but a browser cannot attach that token to the requests it makes
 * on its own behalf — the JS bundle, the CSS, an `<img src>`, a `<video src>`.
 * Without this exchange the page loads and then 401s on everything it needs,
 * which reads as a blank app rather than as an auth failure.
 *
 * So: trade the token for an httpOnly cookie once, before the app mounts, and
 * strip it from the URL afterwards so it does not sit in history or get pasted
 * into a bug report.
 */

const TOKEN_PARAM = 'token'

export async function establishSession(): Promise<void> {
  const url = new URL(window.location.href)
  const token = url.searchParams.get(TOKEN_PARAM)
  if (token === null || token === '') return

  try {
    await fetch(`${import.meta.env.VITE_VIEWER_URL ?? ''}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The cookie is set on the response; nothing is read from it here.
      credentials: 'include',
      body: JSON.stringify({ token }),
    })
  } catch {
    // A failed exchange is not fatal on loopback, where the server exempts
    // local callers anyway. Let the app mount and fail visibly if it cannot
    // reach anything, rather than blocking boot on a network blip.
  }

  url.searchParams.delete(TOKEN_PARAM)
  window.history.replaceState({}, '', url.pathname + url.search + url.hash)
}
