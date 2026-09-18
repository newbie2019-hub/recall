import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { ApiError } from '@recall/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form'
import { useAuth } from '@/lib/auth'
import { paths } from './paths'

/**
 * Sign in — reached *from* the deck list, never placed in front of it.
 *
 * Nothing on this screen is a gate. There is a way back to the collection at
 * the top, a failure is a message on the form rather than a redirect, and the
 * copy says out loud what signing in does to the rows already on this device:
 * they are adopted by the account being signed into (PHASES §5, settled). No
 * prompt, because the alternative — refusing until local rows are exported —
 * strands the person who most needs the account.
 */
const schema = z.object({
  email: z.email('That does not look like an email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

export function SignInPage() {
  const navigate = useNavigate()
  const { signIn } = useAuth()
  const [busy, setBusy] = useState(false)

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: '', password: '' },
  })

  async function submit({ email, password }: z.infer<typeof schema>) {
    setBusy(true)
    try {
      await signIn(email, password)
      toast.success(`Signed in as ${email}`, {
        description: 'The cards already on this device now sync to this account.',
      })
      navigate(paths.decks)
    } catch (e) {
      // Never a redirect and never a wipe: the collection is untouched, so the
      // only thing that changes is this line of text.
      form.setError('root', { message: message(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-6 py-10">
      <Link to={paths.decks} className="text-sm text-muted-foreground hover:text-foreground">
        ← Your cards
      </Link>

      <Card>
        <CardHeader>
          <CardTitle className="font-display text-3xl">Sign in</CardTitle>
          <CardDescription>
            Your cards stay on this device either way — signing in only adds a copy
            on the server. Cards already here join the account you sign into.
          </CardDescription>
        </CardHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} noValidate>
            <CardContent className="grid gap-4">
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="current-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {form.formState.errors.root && (
                <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
              )}
            </CardContent>

            <CardFooter className="mt-6 grid gap-3">
              <Button type="submit" className="w-full" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
              <div className="flex justify-between text-sm text-muted-foreground">
                <Link to={paths.forgotPassword} className="hover:text-foreground">
                  Forgot password
                </Link>
                <Link to={paths.signUp} className="hover:text-foreground">
                  Create an account
                </Link>
              </div>
            </CardFooter>
          </form>
        </Form>
      </Card>
    </main>
  )
}

/**
 * Server prose where there is some — the API writes these for a human and an
 * old build must not second-guess them — and a reassurance where there is not,
 * because "failed to fetch" reads like lost work and nothing was lost.
 */
export function message(e: unknown): string {
  if (e instanceof ApiError && e.code !== 'offline' && e.message) return e.message
  return 'Could not reach the server. Nothing on this device has changed.'
}
