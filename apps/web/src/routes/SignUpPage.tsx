import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
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
 * Create an account.
 *
 * There is no verification step between here and studying: an unverified
 * account syncs, and verification gates publishing to the marketplace only
 * (PHASES §5, Phase 8). A wall here would lock somebody out of a collection
 * that is sitting on their own disk.
 */
const schema = z.object({
  name: z.string().trim().min(1, 'What should we call you?').max(255),
  email: z.email('That does not look like an email address.'),
  // Ten, because that is what the server's one password policy asks for
  // (AppServiceProvider). Checking it here saves a round trip; the server is
  // still the one that decides.
  password: z.string().min(10, 'At least 10 characters. A short phrase beats a clever word.'),
})

export function SignUpPage() {
  const navigate = useNavigate()
  const { signUp } = useAuth()
  const [busy, setBusy] = useState(false)

  const form = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', password: '' },
  })

  async function submit({ name, email, password }: z.infer<typeof schema>) {
    setBusy(true)
    try {
      await signUp(name, email, password)
      toast.success('Account created', {
        description: 'Everything already on this device now syncs to it.',
      })
      navigate(paths.decks)
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
          <CardTitle className="font-display text-3xl">Create an account</CardTitle>
          <CardDescription>
            An account is a backup and a second device. The decks you have made
            already are kept and become this account's.
          </CardDescription>
        </CardHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} noValidate>
            <CardContent className="grid gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Name</FormLabel>
                    <FormControl>
                      <Input autoComplete="name" autoFocus {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" autoComplete="email" {...field} />
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
                      <Input type="password" autoComplete="new-password" {...field} />
                    </FormControl>
                    <FormDescription>
                      No email to confirm. You can study and sync straight away.
                    </FormDescription>
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
                {busy ? 'Creating…' : 'Create account'}
              </Button>
              <Link to={paths.signIn} className="text-sm text-muted-foreground hover:text-foreground">
                I already have an account
              </Link>
            </CardFooter>
          </form>
        </Form>
      </Card>
    </main>
  )
}
