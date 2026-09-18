import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { paths } from './paths'

export function NotFoundPage() {
  const navigate = useNavigate()

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-3 px-6">
      <h1 className="font-display text-3xl">Nothing here</h1>
      <p className="text-sm text-muted-foreground">
        That link does not point at a screen in this app. Your cards are fine.
      </p>
      <Button variant="outline" className="mt-2 self-start" onClick={() => navigate(paths.decks)}>
        All decks
      </Button>
    </div>
  )
}
