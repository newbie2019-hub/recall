import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { paths } from './paths'

/**
 * The published contact, and both ways a notice can arrive.
 *
 * PHASES §8 asks for "a counter-notice flow and a published contact", and this
 * is the published part. It exists as a *page* rather than a line in a dialog
 * because a safe-harbour regime expects an address a stranger can find without
 * an account: someone whose textbook figures were uploaded here has no reason
 * to have signed up, and a contact reachable only from inside the app is not
 * published in any sense that helps them.
 *
 * Recall is operated from Australia, so the regime that governs it is the
 * Copyright Act 1968 — but most notices will arrive DMCA-shaped from US users,
 * because that is the form every other platform asks for. Both are accepted;
 * refusing a notice for being on the wrong template would be a technicality
 * standing in front of a real complaint.
 *
 * **This page is not legal advice and the wording below has not been through a
 * lawyer.** PHASES §8 names that as the one item code cannot de-risk, and the
 * banner says so rather than letting a confident tone imply otherwise.
 */
const CONTACT = import.meta.env?.VITE_ABUSE_CONTACT ?? 'abuse@example.invalid'

export function LegalPage() {
  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-4 py-10 sm:px-6">
      <Button variant="ghost" size="sm" className="-ml-2 mb-6" asChild>
        <Link to={paths.marketplace}>← Explore</Link>
      </Button>

      <h1 className="font-display text-4xl tracking-tight">Rights and takedowns</h1>
      <p className="mt-2 mb-8 text-sm text-muted-foreground">
        Decks in Explore are uploaded by the people who publish them. Every
        published version records who published it and what they claimed the
        rights to it were.
      </p>

      <section className="mb-8">
        <h2 className="mb-2 text-sm tracking-wide uppercase">Contact</h2>
        <p className="font-mono text-sm">{CONTACT}</p>
        <p className="mt-2 text-sm text-muted-foreground">
          Notices, counter-notices and anything else about published material.
          You do not need an account to write.
        </p>
      </section>

      <Separator className="mb-8" />

      <section className="mb-8">
        <h2 className="mb-3 text-sm tracking-wide uppercase">If a deck is yours</h2>
        <p className="mb-3 font-body text-sm">
          Send a notice to the address above. Both intake paths are accepted:
        </p>
        <ul className="ml-5 list-disc space-y-2 font-body text-sm">
          <li>
            <strong>Copyright Act 1968 (Cth)</strong> — the regime this service
            is operated under, as an Australian provider.
          </li>
          <li>
            <strong>DMCA-shaped notices</strong> — the form most senders will
            already have. A notice is not refused for being on the wrong
            template.
          </li>
        </ul>
        <p className="mt-3 font-body text-sm">
          Either way, name the deck (its link is enough), say what material of
          yours it contains, and give us a way to write back. A deck that is
          taken down stops being downloadable immediately.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm tracking-wide uppercase">
          If your deck was taken down
        </h2>
        <p className="font-body text-sm">
          You can file a counter-notice from{' '}
          <Link to={paths.myListings} className="underline hover:text-hematoxylin">
            your published decks
          </Link>
          , or by writing to the address above. It goes to the same queue as the
          report that removed the deck, with the removal attached, and the
          decision that follows is recorded alongside the one it answers.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm tracking-wide uppercase">What a takedown does not do</h2>
        <p className="font-body text-sm">
          It stops distribution. It does not reach into anybody's collection: a
          deck that was already cloned is that person's copy, with their own
          scheduling and their own edits, and nothing here can delete or change
          it. That is a property of how cloning is built, not a policy that could
          be revised.
        </p>
      </section>

      <Separator className="mb-4" />

      <p className="text-xs text-muted-foreground">
        This page describes how notices are handled here. It is not legal advice,
        and it has not been reviewed by a lawyer — see PHASES.md §8.
      </p>
    </div>
  )
}
