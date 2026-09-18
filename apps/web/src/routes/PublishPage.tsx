import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { collectionReady } from '@/db/boot'
import { disclosure, type Disclosure } from '@/db/queries/marketplace'
import { useDecks } from '@/hooks/useDecks'
import { useAuth } from '@/lib/auth'
import { mediaUrl } from '@/lib/media'
import { formatBytes, myListings, publishListing, RIGHTS, type Listing, type RightsClaim } from '@/lib/marketplace'
import { paths } from './paths'

/**
 * Publish one of your own decks.
 *
 * Two things this screen refuses to do. It does not let someone find out at
 * submit that their email is unverified — the requirement is stated before the
 * form, because a publish is preceded by writing a description nobody wants to
 * type twice. And it does not describe what is about to be published in
 * summary: it *shows* it, every tag, every image and the text of the cards,
 * because a deck built from someone's own notes is their own notes, and a count
 * would let them agree to something they have not seen.
 */
export function PublishPage() {
  const { deckId } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { decks } = useDecks()
  const deck = decks?.find((d) => d.id === deckId)

  const [exposed, setExposed] = useState<Disclosure | null>(null)
  const [existing, setExisting] = useState<Listing | null>(null)
  const [form, setForm] = useState({
    title: '',
    description: '',
    tags: '',
    visibility: 'public' as 'public' | 'unlisted',
    changelog: '',
  })
  const [rights, setRights] = useState<RightsClaim | ''>('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!deckId) return
    void (async () => {
      await collectionReady
      setExposed(await disclosure(deckId))
    })()
  }, [deckId])

  // Which version this would be. The deck row does not record that it was ever
  // published — only clones carry a listing id — so the server is asked. A
  // listing here may also be `removed`, which is the one state where publishing
  // again is not what the person wants to do next.
  useEffect(() => {
    if (!user?.email_verified || !deckId) return
    void myListings()
      .then((listings) => setExisting(listings.find((l) => l.deck_id === deckId) ?? null))
      .catch(() => setExisting(null))
  }, [user?.email_verified, deckId])

  useEffect(() => {
    if (deck && !form.title) setForm((f) => ({ ...f, title: deck.name }))
  }, [deck, form.title])

  async function submit() {
    if (!deckId) return
    setBusy(true)
    try {
      const listing = await publishListing({
        deck_id: deckId,
        title: form.title.trim(),
        description: form.description.trim(),
        tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
        visibility: form.visibility,
        changelog: form.changelog.trim(),
        rights_attestation: rights as RightsClaim,
      })
      toast(
        listing.status === 'in_review'
          ? 'Published, and waiting for a moderator to look at it.'
          : `Published. This is v${listing.latest_version}.`,
      )
      navigate(paths.listing(listing.id))
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!decks || !exposed) {
    return (
      <div className="mx-auto min-h-dvh max-w-2xl space-y-4 px-4 py-10 sm:px-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (!deck) {
    return (
      <Gate title="No such deck">
        It may have been deleted, or this link came from another device.
      </Gate>
    )
  }

  // Stated here rather than enforced at submit. Verification gates publishing
  // and nothing else — an unverified account still syncs (UI.md §4).
  if (!user) {
    return (
      <Gate title="Publishing needs an account" action={<Link to={paths.signIn}>Sign in</Link>}>
        A published deck has an author, and reports about it have to reach someone.
        Your cards stay on this device either way.
      </Gate>
    )
  }
  if (!user.email_verified) {
    return (
      <Gate title="Verify your email first" action={<Link to={paths.settings()}>Settings</Link>}>
        Publishing is the one thing that needs a verified address — it is what a
        copyright notice or a moderator's question would be sent to. Everything
        else about your account already works.
      </Gate>
    )
  }

  const ready = form.title.trim() !== '' && rights !== ''

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-10 sm:px-6">
      <Button variant="ghost" size="sm" className="-ml-2 mb-6" asChild>
        <Link to={paths.deck(deck.id)}>← {deck.name}</Link>
      </Button>

      <h1 className="font-display text-4xl tracking-tight">
        {existing ? `Publish v${existing.latest_version + 1}` : 'Publish this deck'}
      </h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">
        A published version is frozen. Editing this deck afterwards changes nothing
        for anyone who cloned it until you publish again — and even then it is an
        offer they can decline.
      </p>

      <section className="specimen-tag mb-8 p-6 pt-8">
        <h2 className="mb-1 text-base">What goes public</h2>
        <p className="mb-4 text-xs text-muted-foreground">
          {deck.path} and everything under it. Anyone with the link can download
          this, including people who are not signed in.
        </p>

        <dl className="mb-4 flex flex-wrap gap-x-8 gap-y-2 font-mono text-xs">
          <Stat label="notes" value={exposed.notes.toLocaleString()} />
          <Stat label="cards" value={exposed.cards.toLocaleString()} />
          <Stat label="decks" value={String(exposed.decks)} />
          <Stat
            label="media"
            value={`${exposed.media.length} · ${formatBytes(exposed.mediaBytes)}`}
          />
        </dl>

        {exposed.tags.length > 0 && (
          <>
            <h3 className="mb-2 text-xs tracking-wide text-muted-foreground uppercase">
              Tags — these travel with the cards
            </h3>
            <p className="mb-4 font-mono text-xs break-words">{exposed.tags.join('  ')}</p>
          </>
        )}

        {exposed.media.length > 0 && (
          <>
            <h3 className="mb-2 text-xs tracking-wide text-muted-foreground uppercase">
              Images and audio
            </h3>
            <MediaStrip media={exposed.media} />
          </>
        )}

        <h3 className="mt-4 mb-2 text-xs tracking-wide text-muted-foreground uppercase">
          Every card, in your words
        </h3>
        <ul className="max-h-64 space-y-1 overflow-auto border border-border p-3 text-xs">
          {exposed.samples.map((line, i) => (
            <li key={i} className="truncate text-muted-foreground">
              {line}
            </li>
          ))}
          {exposed.notes > exposed.samples.length && (
            <li className="pt-1 font-mono">
              …and {(exposed.notes - exposed.samples.length).toLocaleString()} more
            </li>
          )}
        </ul>

        <p className="mt-4 text-xs text-muted-foreground">
          Your review history and your scheduling are not published — the package
          is the notes, their tags and their note types.
        </p>
        {exposed.media.length > 0 && (
          <p className="mt-2 text-xs text-eosin">
            Images and audio do not travel with a published deck yet. The
            {' '}{exposed.media.length} files above stay on this device, and the cards
            that use them arrive without them. Worth knowing before you publish a
            deck that is mostly plates.
          </p>
        )}
      </section>

      <div className="grid gap-5">
        <Field label="Title" id="title">
          <Input
            id="title"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </Field>

        <Field label="Description" id="description" hint="Sources, scope, who it is for.">
          <textarea
            id="description"
            rows={5}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            className="border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </Field>

        <Field label="Tags" id="tags" hint="Comma separated. How people find it.">
          <Input
            id="tags"
            value={form.tags}
            onChange={(e) => setForm({ ...form, tags: e.target.value })}
          />
        </Field>

        {/* Shown whether or not this deck is known to have a listing already:
            `my-listings` does not say which deck a listing came from yet, so the
            screen cannot tell, and a changelog nobody needed costs nothing. */}
        <Field
          label="What changed"
          id="changelog"
          hint="Only used if this deck has been published before. It is what people decide an update on."
        >
          <textarea
            id="changelog"
            rows={3}
            value={form.changelog}
            onChange={(e) => setForm({ ...form, changelog: e.target.value })}
            className="border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
        </Field>

        <Field label="Who can find it" id="visibility">
          <Select
            value={form.visibility}
            onValueChange={(v) => setForm({ ...form, visibility: v as 'public' | 'unlisted' })}
          >
            <SelectTrigger id="visibility">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public — listed in Explore</SelectItem>
              <SelectItem value="unlisted">Unlisted — only people with the link</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            A new account stays unlisted until a moderator has looked at its first
            deck. The listing page always says which one it is.
          </p>
        </Field>

        <Separator />

        <Field label="This is mine to publish because" id="rights">
          <Select value={rights} onValueChange={(v) => setRights(v as RightsClaim)}>
            <SelectTrigger id="rights">
              <SelectValue placeholder="Choose one — it is recorded with the version" />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(RIGHTS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Recorded with the version, along with the address it was published
            from. It is what a copyright notice is answered with.
          </p>
        </Field>

        <Button size="lg" disabled={!ready || busy} onClick={() => void submit()}>
          {busy ? 'Publishing…' : existing ? `Publish v${existing.latest_version + 1}` : 'Publish'}
        </Button>
      </div>
    </div>
  )
}

/** Thumbnails come from the local store — these are the bytes about to be sent. */
function MediaStrip({ media }: { media: Disclosure['media'] }) {
  const [urls, setUrls] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const images = media.filter((m) => m.mime.startsWith('image/')).slice(0, 12)
      const resolved = await Promise.all(
        images.map(async (m) => [m.sha256, await mediaUrl(m.sha256)] as const),
      )
      if (!cancelled) {
        setUrls(Object.fromEntries(resolved.filter((r): r is [string, string] => !!r[1])))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [media])

  const other = media.filter((m) => !m.mime.startsWith('image/'))

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1">
        {Object.entries(urls).map(([sha, url]) => (
          <img
            key={sha}
            src={url}
            alt=""
            className="size-14 border border-border object-cover"
          />
        ))}
      </div>
      <p className="font-mono text-[0.6875rem] text-muted-foreground">
        {media.length} files
        {other.length > 0 && `, including ${other.length} audio or video`}
        {media.length > 12 && ', showing the first 12'}
      </p>
    </div>
  )
}

const Field = ({
  label, id, hint, children,
}: { label: string; id: string; hint?: string; children: React.ReactNode }) => (
  <div className="grid gap-2">
    <Label htmlFor={id}>{label}</Label>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
)

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-baseline gap-2">
    <dt className="text-muted-foreground">{label}</dt>
    <dd className="text-sm">{value}</dd>
  </div>
)

const Gate = ({
  title, action, children,
}: { title: string; action?: React.ReactNode; children: React.ReactNode }) => (
  <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
    <h1 className="font-display text-3xl">{title}</h1>
    <p className="text-sm text-muted-foreground">{children}</p>
    <div className="mt-2 flex gap-2">
      {action && (
        <Button variant="outline" asChild>
          {action}
        </Button>
      )}
      <Button variant="ghost" asChild>
        <Link to={paths.decks}>All decks</Link>
      </Button>
    </div>
  </div>
)
