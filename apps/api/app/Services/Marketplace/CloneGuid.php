<?php

declare(strict_types=1);

namespace App\Services\Marketplace;

/**
 * The guid a cloned note gets, and the reason it is not the publisher's.
 *
 * Import matches notes on `guid` and `notes` is unique on (user_id, guid)
 * (CARDS.md §4.5). Copying the publisher's guids verbatim therefore breaks in
 * three ways, all of them silent and all of them collection-corrupting:
 *
 *  1. cloning your own listing back into your own account matches your originals
 *     and overwrites the notes you published;
 *  2. cloning the same listing twice — or a deck and a fork of it — makes the
 *     second clone update the first instead of arriving as its own deck;
 *  3. exporting both to `.apkg` and importing them into one Anki collection
 *     merges two decks that share no scheduling into one.
 *
 * So a clone mints its own guid, derived from the guid upstream published *and*
 * the id of the deck it was cloned into. Derived rather than random because the
 * merge of v4 onto v3 has to find the note it already holds: the client
 * recomputes this from the published `source_guid` and the local deck id, and
 * lands on the same 16 hex characters it minted at clone time. No mapping table,
 * no extra column, and two clones of one listing can coexist in one collection.
 *
 * Sixteen hex characters is what `lower(hex(randomblob(8)))` produces in
 * packages/core/src/schema.ts, so a derived guid is indistinguishable from a
 * minted one everywhere downstream — export included.
 *
 * The web client mirrors this function. It is three lines and it has to stay
 * identical in both; a change here is a change that orphans every clone.
 */
final class CloneGuid
{
    public static function derive(string $deckId, string $sourceGuid): string
    {
        return substr(hash('sha256', $deckId.':'.$sourceGuid), 0, 16);
    }
}
