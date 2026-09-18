<?php

namespace Tests;

use Illuminate\Foundation\Testing\TestCase as BaseTestCase;
use Illuminate\Support\Facades\Auth;

abstract class TestCase extends BaseTestCase
{
    /**
     * Send the next requests as this bearer token.
     *
     * The `forgetGuards()` is load-bearing. Within one test every request shares
     * a container, and the auth guard memoises the user it resolved first — so a
     * second request with a different token silently keeps the first identity.
     * That is a test-harness artifact, not a production one (a real request gets
     * a fresh guard), but without this a test that switches accounts proves
     * nothing at all.
     */
    protected function actingAsToken(string $plainTextToken): static
    {
        Auth::forgetGuards();

        return $this->withHeader('Authorization', 'Bearer '.$plainTextToken);
    }
}
