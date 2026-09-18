<?php

namespace App\Models;

use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Laravel\Sanctum\PersonalAccessToken as SanctumToken;

/**
 * Sanctum's token, keyed by uuid like everything else here.
 *
 * Sanctum's own model assumes an auto-incrementing id. The id also travels: the
 * plain-text token a client holds is `<id>|<secret>`, so an integer would put a
 * count of every token ever issued into a string that gets pasted into bug
 * reports and proxy logs.
 */
class PersonalAccessToken extends SanctumToken
{
    use HasUuids;
}
