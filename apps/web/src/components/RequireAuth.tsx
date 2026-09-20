import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from '@/lib/auth'
import { paths } from '@/routes/paths'

/**
 * The wall.
 *
 * Until now this app had none, and three files argued at length that it never
 * should — signing in was a state, not a gate. That was a product decision and
 * it has been reversed: an account is now required, and the marketing data
 * collected at `/welcome` is part of why.
 *
 * The engineering objection behind those comments was never about walls in
 * general, though, and it still stands: **a dead network must not lock you out
 * of cards that are already on your device.** So this guard deliberately does
 * *not* ask "did the server just confirm you". It asks "has this browser ever
 * held a confirmed session", which `lib/auth.tsx` answers from the cached user
 * even when `me()` cannot be reached. Offline, on a plane, with an expired
 * token: you stay in, the banner says sync is paused, and the collection works.
 * Only an explicit sign-out puts the wall back up.
 *
 * Three states, in the order they have to be checked:
 *
 * 1. **Still checking.** Render nothing rather than redirect — a guard that
 *    redirects while the stored token is resolving makes every refresh flash
 *    the sign-in page before bouncing back.
 * 2. **Never signed in here.** Send them to sign-in, carrying where they were
 *    going, so a shared deck link survives the detour.
 * 3. **Signed in, onboarding unfinished.** Send them to `/welcome` — except
 *    when they are already there, which would be a redirect loop.
 */
export function RequireAuth() {
  const { user, loading } = useAuth()
  const location = useLocation()

  if (loading) return null

  if (!user) {
    return <Navigate to={paths.signIn} replace state={{ from: location.pathname + location.search }} />
  }

  if (!user.onboarded && !location.pathname.startsWith(paths.welcome)) {
    return <Navigate to={paths.welcome} replace />
  }

  return <Outlet />
}
