import { Button } from '@/components/ui/button'
import { Rating, formatInterval, type RatingValue } from '@recall/core'

const BUTTONS = [
  { rating: Rating.Again, label: 'Again', variant: 'again' },
  { rating: Rating.Hard, label: 'Hard', variant: 'hard' },
  { rating: Rating.Good, label: 'Good', variant: 'good' },
  { rating: Rating.Easy, label: 'Easy', variant: 'easy' },
] as const

export function RatingBar({
  intervals,
  now,
  onRate,
}: {
  intervals: Record<RatingValue, number>
  now: number
  onRate: (r: RatingValue) => void
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      {BUTTONS.map(({ rating, label, variant }) => (
        <Button
          key={rating}
          variant={variant}
          size="lg"
          className="h-auto flex-col gap-0.5 py-3"
          onClick={() => onRate(rating)}
        >
          <span className="flex items-baseline gap-1.5 text-sm font-medium">
            <span className="font-mono text-[0.625rem] opacity-60">{rating}</span>
            {label}
          </span>
          <span className="font-mono text-[0.6875rem] opacity-70">
            {formatInterval(now, intervals[rating])}
          </span>
        </Button>
      ))}
    </div>
  )
}
