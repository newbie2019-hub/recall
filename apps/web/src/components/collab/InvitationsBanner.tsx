import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/lib/auth'
import {
  acceptInvitation, declineInvitation, fetchInvitations, type Invitation,
} from '@/lib/collab/transport'

/**
 * Deck invitations, on the deck list.
 *
 * There is no email being sent yet, so this *is* the delivery mechanism — an
 * invitation that only exists as a row is an invitation nobody receives, which
 * is the same failure the marketplace had before Phase 8's audit: a feature
 * with no way in.
 *
 * It renders nothing at all when there is nothing waiting, which is almost
 * always. A permanent empty box on the front door to advertise a feature is
 * worse than no box.
 */
export function InvitationsBanner({ onJoined }: { onJoined: () => void }) {
  const { user } = useAuth()
  const [pending, setPending] = useState<Invitation[]>([])
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!user) {
      setPending([])
      return
    }
    // Silent on failure: this is an extra, and a deck list must not grow an
    // error banner because an optional call did not answer.
    fetchInvitations()
      .then((r) => setPending(r.pending))
      .catch(() => setPending([]))
  }, [user])

  useEffect(() => void load(), [load])

  if (!pending.length) return null

  async function respond(invitation: Invitation, accept: boolean) {
    setBusy(invitation.id)
    try {
      if (accept) {
        await acceptInvitation(invitation.id)
        toast(`Joined “${invitation.deck_name}”. It syncs to this device from now on.`)
        onJoined()
      } else {
        await declineInvitation(invitation.id)
      }
      setPending((list) => list.filter((i) => i.id !== invitation.id))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <ul className="mb-6 space-y-2">
      {pending.map((invitation) => (
        <li
          key={invitation.id}
          className="flex flex-wrap items-center gap-3 border border-border p-3"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm">
              {invitation.invited_by ?? 'Somebody'} shared{' '}
              <strong>{invitation.deck_name ?? 'a deck'}</strong> with you
            </p>
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              as {invitation.role} · you edit the same notes, your scheduling stays yours
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={busy === invitation.id}
              onClick={() => void respond(invitation, true)}
            >
              Join
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === invitation.id}
              onClick={() => void respond(invitation, false)}
            >
              Decline
            </Button>
          </div>
        </li>
      ))}
    </ul>
  )
}
