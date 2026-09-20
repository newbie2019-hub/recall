import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { ApiError } from '@recall/core'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useDecks } from '@/hooks/useDecks'
import { useAuth } from '@/lib/auth'
import {
  fetchRoster, inviteCollaborator, removeCollaborator, setCollaboratorRole,
  type Collaborator, type Roster,
} from '@/lib/collab/transport'
import { NotFoundPage } from './NotFoundPage'
import { paths } from './paths'

/**
 * Who a deck is shared with (Phase 9).
 *
 * The screen says what each role can do in the words of the thing it affects,
 * not as three words in a dropdown: the server cannot judge a collaborative
 * edit — it holds Yjs blobs it cannot read — so choosing a role *is* the
 * moderation decision for this deck, and it has to be made with the
 * consequences visible.
 *
 * It also says plainly what removal does not do. Somebody's edits are merged
 * into the document and into every other copy already; revoking access does not
 * unpick them, and implying otherwise would be a promise the CRDT cannot keep.
 */
const ROLES: { value: Collaborator['role']; label: string; detail: string }[] = [
  { value: 'viewer', label: 'Viewer', detail: 'Reads the deck and watches edits arrive. Writes nothing.' },
  { value: 'editor', label: 'Editor', detail: 'Edits notes with you, live.' },
  { value: 'admin', label: 'Admin', detail: 'Edits, and invites or removes other people.' },
]

export function SharePage() {
  const { deckId } = useParams()
  const { user, loading } = useAuth()
  const { decks } = useDecks()
  const deck = decks?.find((d) => d.id === deckId)

  const [roster, setRoster] = useState<Roster | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Collaborator['role']>('editor')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    if (!deckId || !user) return
    fetchRoster(deckId)
      .then(setRoster)
      .catch((e: unknown) => setError(e instanceof Error ? e : new Error(String(e))))
  }, [deckId, user])

  useEffect(() => void load(), [load])

  if (error instanceof ApiError && (error.code === 'forbidden' || error.code === 'not_found')) {
    return <NotFoundPage />
  }

  if (loading) {
    return (
      <div className="mx-auto min-h-dvh max-w-2xl space-y-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  }

  if (!user) {
    return (
      <Gate title="Sharing needs an account">
        A shared deck syncs through the server, so the people you share it with
        have to be able to reach it. Your collection on this device works either
        way.
      </Gate>
    )
  }

  if (!deckId) return <NotFoundPage />

  const canManage = roster?.role === 'owner' || roster?.role === 'admin'

  async function invite() {
    if (!deckId) return
    setBusy(true)
    try {
      const result = await inviteCollaborator(deckId, email.trim(), role)
      setRoster((r) => (r ? { ...r, collaborators: result.collaborators } : r))
      setEmail('')
      toast('Invited. They join once they accept.')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-10 sm:px-6">
      <Button variant="ghost" size="sm" className="-ml-2 mb-6" asChild>
        <Link to={deck ? paths.deck(deck.id) : paths.decks}>← {deck?.name ?? 'Deck'}</Link>
      </Button>

      <h1 className="font-display text-4xl tracking-tight">Share this deck</h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">
        Everyone here edits the same notes, at the same time. Scheduling stays
        yours — what you have studied is never shared, only what the cards say.
      </p>

      {!roster && !error && <Skeleton className="h-40 w-full" />}
      {error && <p className="font-mono text-xs text-eosin">{error.message}</p>}

      {roster && (
        <>
          <ul className="mb-8 divide-y divide-border border-y border-border">
            {roster.collaborators.map((c) => (
              <li key={c.id ?? 'owner'} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{c.name ?? c.email}</p>
                  <p className="truncate font-mono text-[0.6875rem] text-muted-foreground">
                    {c.email}
                    {c.accepted_at === null && ' · invitation not accepted yet'}
                  </p>
                </div>

                {c.role === 'owner' || !canManage || !c.id ? (
                  <Badge variant="outline" className="font-mono text-[0.625rem]">
                    {c.role}
                  </Badge>
                ) : (
                  <>
                    <Select
                      value={c.role}
                      onValueChange={(v) => {
                        void setCollaboratorRole(deckId, c.id!, v)
                          .then((r) => setRoster((cur) => (cur ? { ...cur, collaborators: r.collaborators } : cur)))
                          .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
                      }}
                    >
                      <SelectTrigger size="sm" className="w-28 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {ROLES.map((r) => (
                          <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${c.name ?? c.email}`}
                      onClick={() => {
                        void removeCollaborator(deckId, c.id!)
                          .then((r) => {
                            setRoster((cur) => (cur ? { ...cur, collaborators: r.collaborators } : cur))
                            toast('Removed. Their edits stay — a shared document has no way to unpick them.')
                          })
                          .catch((e: unknown) => toast(e instanceof Error ? e.message : String(e)))
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ul>

          {canManage ? (
            <section className="specimen-tag p-5 pt-7">
              <h2 className="mb-4 text-base">Invite somebody</h2>
              <div className="grid gap-4">
                <div className="grid gap-2">
                  <Label htmlFor="invite-email">Their email</Label>
                  <Input
                    id="invite-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="them@example.com"
                  />
                  <p className="text-xs text-muted-foreground">
                    They do not need an account yet. The invitation waits until
                    they have one, and grants nothing until they accept it.
                  </p>
                </div>

                <div className="grid gap-2">
                  <Label htmlFor="invite-role">What they may do</Label>
                  <Select value={role} onValueChange={(v) => setRole(v as Collaborator['role'])}>
                    <SelectTrigger id="invite-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {ROLES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">
                    {ROLES.find((r) => r.value === role)?.detail}
                  </p>
                </div>

                <Button disabled={busy || !email.trim()} onClick={() => void invite()}>
                  {busy ? 'Inviting…' : 'Send invitation'}
                </Button>
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Nobody's edits can be reviewed before they land — a live document
                merges them as they are typed, and the server holds them as bytes
                it cannot read. Who you invite is the decision that matters.
              </p>
            </section>
          ) : (
            <p className="text-sm text-muted-foreground">
              You are a {roster.role} on this deck. Only the owner and admins can
              change who it is shared with.
            </p>
          )}
        </>
      )}
    </div>
  )
}

const Gate = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
    <h1 className="font-display text-3xl">{title}</h1>
    <p className="text-sm text-muted-foreground">{children}</p>
    <div className="mt-2 flex gap-2">
      <Button variant="outline" asChild>
        <Link to={paths.signIn}>Sign in</Link>
      </Button>
      <Button variant="ghost" asChild>
        <Link to={paths.decks}>All decks</Link>
      </Button>
    </div>
  </div>
)
