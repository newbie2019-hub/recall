<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One relationship between two accounts, held once and read from both ends.
 *
 * Everything reader-relative lives here rather than in the resource, because
 * "am I the one who asked?" is a fact about the row and getting it backwards
 * puts an Accept button in front of the person who sent the request.
 */
#[Fillable(['id', 'requester_id', 'addressee_id', 'accepted_at'])]
class Friendship extends Model
{
    use HasUuids;

    public const STATUS_ACCEPTED = 'accepted';

    /** Somebody asked me. Mine to accept or decline. */
    public const STATUS_PENDING_IN = 'pending_in';

    /** I asked somebody. Mine to cancel, theirs to answer. */
    public const STATUS_PENDING_OUT = 'pending_out';

    protected function casts(): array
    {
        return ['accepted_at' => 'datetime'];
    }

    public function requester(): BelongsTo
    {
        return $this->belongsTo(User::class, 'requester_id');
    }

    public function addressee(): BelongsTo
    {
        return $this->belongsTo(User::class, 'addressee_id');
    }

    /**
     * Every row this person is on, in either seat.
     *
     * The closure is not decoration: an unnested `orWhere` here would escape
     * any other constraint on the query — `accepted()->involving($user)` would
     * quietly return every accepted friendship on the server.
     *
     * @param  Builder<self>  $query
     * @return Builder<self>
     */
    public function scopeInvolving(Builder $query, User $user): Builder
    {
        return $query->where(fn (Builder $inner): Builder => $inner
            ->where('requester_id', $user->id)
            ->orWhere('addressee_id', $user->id));
    }

    /**
     * The row between these two, whichever way round it was asked.
     *
     * @param  Builder<self>  $query
     * @return Builder<self>
     */
    public function scopeBetween(Builder $query, User $one, User $other): Builder
    {
        return $query
            ->whereIn('requester_id', [$one->id, $other->id])
            ->whereIn('addressee_id', [$one->id, $other->id]);
    }

    /**
     * @param  Builder<self>  $query
     * @return Builder<self>
     */
    public function scopeAccepted(Builder $query): Builder
    {
        return $query->whereNotNull('accepted_at');
    }

    public function involves(User $user): bool
    {
        return $this->requester_id === $user->id || $this->addressee_id === $user->id;
    }

    /** The other person, from this reader's side of the row. */
    public function otherParty(User $reader): User
    {
        return $this->requester_id === $reader->id ? $this->addressee : $this->requester;
    }

    public function statusFor(User $reader): string
    {
        if ($this->accepted_at !== null) {
            return self::STATUS_ACCEPTED;
        }

        return $this->requester_id === $reader->id
            ? self::STATUS_PENDING_OUT
            : self::STATUS_PENDING_IN;
    }
}
