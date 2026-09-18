import { cn } from '@/lib/utils'

/**
 * The signature element: a flashcard is a specimen label.
 * Hairline double rule, notched corner, a real catalog number. Reused by the
 * review screen, and later by marketplace tiles and the authoring preview.
 */
export function SpecimenTag({
  catalog,
  path,
  className,
  children,
}: {
  catalog: string
  path?: string
  className?: string
  children: React.ReactNode
}) {
  return (
    <article className={cn('specimen-tag flex min-h-[18rem] flex-col p-6 sm:p-10', className)}>
      <div className="mb-6 flex items-start justify-between gap-4 pl-10">
        <span className="font-mono text-[0.6875rem] tracking-wider text-muted-foreground">
          {catalog}
        </span>
      </div>

      <div className="flex flex-1 items-center">{children}</div>

      {path && (
        <p className="mt-6 font-sans text-[0.625rem] tracking-[0.18em] text-muted-foreground uppercase">
          {path}
        </p>
      )}
    </article>
  )
}
