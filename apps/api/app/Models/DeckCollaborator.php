<?php

declare(strict_types=1);

namespace App\Models;

use Illuminate\Database\Eloquent\Attributes\Fillable;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Concerns\HasUuids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One person's standing on one shared deck.
 *
 * The three roles are the entire anti-vandalism story for collaborative content
 * (CRITIQUE.md §3): the server cannot read a Yjs update, so it cannot reject a
 * bad one — it can only decide who is allowed to send any at all.
 *
 * - `viewer` reads the document and the presence channel. Sends nothing.
 * - `editor` sends updates.
 * - `admin` sends updates *and* changes who else may.
 *
 * The deck's owner has all three and holds none of them through this table.
 */
#[Fillable(['id', 'deck_id', 'user_id', 'invited_email', 'role', 'invited_by', 'accepted_at'])]
class DeckCollaborator extends Model
{
    use HasUuids;

    public const ROLE_VIEWER = 'viewer';

    public const ROLE_EDITOR = 'editor';

    public const ROLE_ADMIN = 'admin';

    /** @var list<string> */
    public const ROLES = [self::ROLE_VIEWER, self::ROLE_EDITOR, self::ROLE_ADMIN];

    protected function casts(): array
    {
        return ['accepted_at' => 'datetime'];
    }

    public function deck(): BelongsTo
    {
        return $this->belongsTo(Deck::class);
    }

    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    public function inviter(): BelongsTo
    {
        return $this->belongsTo(User::class, 'invited_by');
    }

    /**
     * Rows that actually grant something: accepted, and attached to an account.
     *
     * Every authorization read goes through this. An invitation that has been
     * sent and not accepted must never be the row that lets somebody in, and
     * "accepted_at is set" is the one check that says so.
     *
     * @param  Builder<self>  $query
     * @return Builder<self>
     */
    public function scopeActive(Builder $query): Builder
    {
        return $query->whereNotNull('accepted_at')->whereNotNull('user_id');
    }

    public function isActive(): bool
    {
        return $this->accepted_at !== null && $this->user_id !== null;
    }

    public function canWrite(): bool
    {
        return $this->isActive() && in_array($this->role, [self::ROLE_EDITOR, self::ROLE_ADMIN], true);
    }

    public function canManage(): bool
    {
        return $this->isActive() && $this->role === self::ROLE_ADMIN;
    }
}
