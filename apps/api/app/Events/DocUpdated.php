<?php

declare(strict_types=1);

namespace App\Events;

use Illuminate\Broadcasting\InteractsWithSockets;
use Illuminate\Broadcasting\PresenceChannel;
use Illuminate\Contracts\Broadcasting\ShouldBroadcastNow;
use Illuminate\Foundation\Events\Dispatchable;

/**
 * One collaborator's edit, on its way to everybody else in the deck.
 *
 * `ShouldBroadcastNow`, not `ShouldBroadcast`: this is a keystroke on its way
 * to another person's screen, and putting it on a queue adds the queue's
 * latency plus a worker as a hard dependency of typing. The cost is that the
 * HTTP request that posted the update also pays for the Reverb call — a few
 * milliseconds, against a round trip the client is already waiting on.
 *
 * The payload is the same opaque base64 the client sent. Nothing here parses
 * it, which is the point: PHP rebroadcasts bytes whose meaning only Yjs knows
 * (PHASES §9).
 */
final class DocUpdated implements ShouldBroadcastNow
{
    use Dispatchable;
    use InteractsWithSockets;

    public function __construct(
        public string $deckId,
        public int $seq,
        public string $payload,
        public ?string $actorId,
    ) {}

    /**
     * A presence channel, not a private one, because presence *is* a feature
     * here: the member list is where the avatars on the editor come from, and a
     * private channel would mean a second channel just to answer "who else is
     * here".
     */
    public function broadcastOn(): PresenceChannel
    {
        return new PresenceChannel('deck.'.$this->deckId);
    }

    public function broadcastAs(): string
    {
        return 'doc.updated';
    }

    /**
     * @return array<string, mixed>
     */
    public function broadcastWith(): array
    {
        return [
            'seq' => $this->seq,
            'payload' => $this->payload,
            'actor_id' => $this->actorId,
        ];
    }
}
