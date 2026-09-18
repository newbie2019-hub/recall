<?php

namespace App\Providers;

use App\Models\PersonalAccessToken;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\ServiceProvider;
use Illuminate\Validation\Rules\Password;
use Laravel\Sanctum\Sanctum;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        //
    }

    public function boot(): void
    {
        Sanctum::usePersonalAccessTokenModel(PersonalAccessToken::class);

        // One password policy, defined once, so sign-up and password reset
        // cannot drift apart and start disagreeing about what is acceptable.
        //
        // Length over composition rules: a passphrase beats `P@ssw0rd`, and the
        // breach corpus is the only one of these checks that reflects how
        // accounts are actually taken. It costs a live call to the
        // haveibeenpwned range API, so it runs in production only — a test
        // suite that needs the network to check a password is a test suite that
        // fails on a train.
        Password::defaults(fn () => $this->app->isProduction()
            ? Password::min(10)->uncompromised()
            : Password::min(10));

        // Every relationship in this schema is declared. Letting Eloquent
        // silently lazy-load one turns a sync pull over 20,000 notes into 20,000
        // queries, and it does it quietly — the endpoint just gets slower until
        // somebody profiles it.
        Model::preventLazyLoading($this->app->isLocal());
    }
}
