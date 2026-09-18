import { useState } from 'react'
import { Link } from 'react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import {
  Form, FormControl, FormField, FormItem, FormLabel, FormMessage,
} from '@/components/ui/form'
import { useAuth } from '@/lib/auth'
import { message } from './SignInPage'
import { paths } from './paths'

/**
 * Ask for a reset link.
 *
 * The confirmation deliberately does not say whether that address has an
 * account — the server answers identically either way, so saying more here
 * would be inventing it, and the endpoint would become a way to test which
 * addresses are registered.
 */
const schema = z.object({ email: z.email('That does not look like an email address.') })

export function ForgotPasswordPage() {
  const { client } = useAuth()
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  })

  async function submit({ email }: z.infer<typeof schema>) {
    setBusy(true)
    try {
      await client.forgotPassword(email)
      setSentTo(email)
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
          <CardTitle className="font-display text-3xl">Forgot password</CardTitle>
          <CardDescription>
            {sentTo
              ? `If ${sentTo} has an account, a link is on its way. It works for one hour.`
              : 'We will email a link that sets a new one. Your cards on this device are not affected.'}
          </CardDescription>
        </CardHeader>

        {sentTo ? (
          <CardFooter className="grid gap-3">
            <Button variant="outline" className="w-full" onClick={() => setSentTo(null)}>
              Send it again
            </Button>
            <Link to={paths.signIn} className="text-sm text-muted-foreground hover:text-foreground">
              Back to sign in
            </Link>
          </CardFooter>
        ) : (
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
                {form.formState.errors.root && (
                  <p className="text-sm text-destructive">{form.formState.errors.root.message}</p>
                )}
              </CardContent>

              <CardFooter className="mt-6 grid gap-3">
                <Button type="submit" className="w-full" disabled={busy}>
                  {busy ? 'Sending…' : 'Email me a link'}
                </Button>
                <Link to={paths.signIn} className="text-sm text-muted-foreground hover:text-foreground">
                  Back to sign in
                </Link>
              </CardFooter>
            </form>
          </Form>
        )}
      </Card>
    </main>
  )
}
