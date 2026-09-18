<?php

namespace Tests\Feature;

use App\Contracts\Repositories\UserRepository;
use App\Models\Deck;
use App\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use Tests\TestCase;

/**
 * The sync cursor. If these break, a device silently stops seeing rows, which
 * is the one failure mode sync can have that nobody notices until data is gone.
 */
class SyncRevisionTest extends TestCase
{
    use RefreshDatabase;

    private UserRepository $users;

    protected function setUp(): void
    {
        parent::setUp();
        $this->users = app(UserRepository::class);
    }

    public function test_revisions_are_allocated_in_blocks_and_never_repeat(): void
    {
        $user = User::factory()->create();

        $this->assertSame(1, $this->users->allocateRevisions($user, 3), 'the first block starts at 1');
        $this->assertSame(4, $this->users->allocateRevisions($user, 2), 'the next block starts after it');
        $this->assertSame(5, $user->fresh()->sync_revision);

        // Different accounts count independently — one user's writes must not
        // push another user's devices past rows they have not seen.
        $other = User::factory()->create();
        $this->assertSame(1, $this->users->allocateRevisions($other));
    }

    public function test_a_pull_returns_only_what_is_above_the_cursor_in_revision_order(): void
    {
        $user = User::factory()->create();
        $ids = [];

        foreach (['Anatomy', 'Thorax', 'Heart'] as $name) {
            $ids[$name] = (string) Str::uuid();
            Deck::create([
                'id' => $ids[$name],
                'user_id' => $user->id,
                'name' => $name,
                'revision' => $this->users->allocateRevisions($user),
                'client_updated_at' => 1_700_000_000_000,
            ]);
        }

        $since = fn (int $cursor) => Deck::query()
            ->ownedBy($user)->changedSince($cursor)->pluck('name')->all();

        $this->assertSame(['Anatomy', 'Thorax', 'Heart'], $since(0));
        $this->assertSame(['Heart'], $since(2));
        $this->assertSame([], $since(3), 'a caught-up device pulls nothing');

        // An update re-stamps the row, so it comes back to a device that had
        // already seen the older version.
        Deck::find($ids['Anatomy'])->update(['revision' => $this->users->allocateRevisions($user)]);
        $this->assertSame(['Anatomy'], $since(3));
    }
}
