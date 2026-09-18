<?php

namespace App\Models\Concerns;

use App\Models\User;
use Illuminate\Database\Eloquent\Builder;

/**
 * Shared behaviour for every table a device pulls.
 *
 * Two things are common to all of them. Primary keys come from the client and
 * are strings — a uuid for a note, `<note id>:<ord>` for a card, `anki:<mid>`
 * for an imported note type — so Eloquent must stop assuming an
 * auto-incrementing integer. And every row carries the revision it was written
 * at, which is what a pull filters on.
 */
trait SyncsToDevices
{
    /**
     * Eloquent calls this on every instance that uses the trait.
     *
     * Declaring `$incrementing` as a trait property instead is a fatal error:
     * `Model` already declares it with a different value, and PHP refuses the
     * composition rather than picking a winner.
     */
    public function initializeSyncsToDevices(): void
    {
        $this->incrementing = false;
        $this->keyType = 'string';
    }

    /**
     * Rows this device has not seen, oldest change first.
     *
     * Ordering by revision rather than by `updated_at` is what makes the cursor
     * total: no two writes share a revision, so a page boundary can never fall
     * between two rows that compare equal and silently skip one.
     */
    public function scopeChangedSince(Builder $query, int $cursor): Builder
    {
        return $query->where('revision', '>', $cursor)->orderBy('revision');
    }

    public function scopeOwnedBy(Builder $query, User|int $user): Builder
    {
        return $query->where('user_id', $user instanceof User ? $user->id : $user);
    }
}
