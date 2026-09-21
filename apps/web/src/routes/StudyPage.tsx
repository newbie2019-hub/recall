import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Review } from '@/components/Review'
import { paths } from './paths'

/**
 * `/study` for the whole collection, `/decks/:id/study` for one subtree.
 *
 * Two paths rather than a query parameter: studying a deck is a place you can
 * be sent to — from the deck list, from a link, and from a phone home-screen
 * shortcut in Phase 12 — and those all want a URL that names the deck.
 *
 * Together mode *is* a query parameter, for the opposite reason: it is not a
 * different queue or a different screen, it is the same study session with one
 * line added, and the URL that names the deck should keep naming the deck. It
 * also makes joining a room a link somebody can paste into a group chat, which
 * is the only invitation this feature has.
 */
export function StudyPage() {
  const navigate = useNavigate()
  const { deckId } = useParams()
  const [params] = useSearchParams()

  return (
    // "Back to decks" means the deck list, including when the session was
    // scoped to one deck — the button says where it goes, and somewhere else is
    // a small lie the user has to learn.
    <Review
      deckId={deckId ?? null}
      session={params.get('session') === '1'}
      onExit={() => navigate(paths.decks)}
    />
  )
}
