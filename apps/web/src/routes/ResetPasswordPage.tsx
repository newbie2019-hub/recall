import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form'
import { useAuth } from '@/lib/auth'
import { message } from './SignInPage'
import { paths } from './paths'

/**
 * Where the mail link lands: `/reset/:token?email=…`.
 *
 * Both halves come off the URL because the broker needs the pair — a token
 * alone says nothing about whose account it unlocks. The address is shown
 * rather than hidden, so somebody who followed the link on a shared machine can
 * see which account they are about to change, and editable, because a mail
 * client that mangles the query string should not dead-end the reset.
 */
const schema = z
  .object({
    email: z.email('That does not look like an email address.'),
    password: z.string().min(10, 'At least 10 characters. A short phrase beats a clever word.'),
    confirm: z.string(),
  })
  // Checked here only. The server never sees the confirmation: it is a typo
  // guard, not a rule about what a password may be.
  .refine((v) => v.password === v.confirm, {
    message: 'These two do not match.',
    path: ['confirm'],
  })

export function ResetPasswordPage() {
  const { token = '' } = useParams()
  const [search] = useSearchParams()
  const navigate = useNavigate()
  const { client } = useAuth()
  const [busy, setBusy] = useState(false)

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: search.get('email') ?? '', password: '', confirm: '' },
  })

  async function submit({ email, password }: z.infer<typeof schema>) {
    setBusy(true)
    try {
      await client.resetPassword({ token, email, password })
      // A reset signs every device out, including this one, so there is no
      // session to adopt here — the new password has to be used once.
      toast.success('Password changed', { description: 'Sign in with it to start syncing again.' })
      navigate(paths.signIn)
    } catch (e) {
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
          <CardTitle className="font-display text-3xl">Set a new password</CardTitle>
          <CardDescription>
            Every device signed into this account is signed out, and each one
            picks up where it left off next time it signs in.
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
                    <FormLabel>Account</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="username" {...field} />
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
                    <FormLabel>New password</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="confirm"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Again</FormLabel>
                    <FormControl>
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {!token && (
                <FormDescription className="text-destructive">
                  This link is missing its token. Ask for a new one.
                </FormDescription>
              )}
              {form.formState.errors.root && (
                <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
              )}
            </CardContent>

            <CardFooter className="mt-6 grid gap-3">
              <Button type="submit" className="w-full" disabled={busy || !token}>
                {busy ? 'Saving…' : 'Change password'}
              </Button>
              <Link
                to={paths.forgotPassword}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Send a new link
              </Link>
            </CardFooter>
          </form>
        </Form>
      </Card>
    </main>
  )
}
