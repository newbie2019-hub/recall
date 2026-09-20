<?php

declare(strict_types=1);

namespace App\Services\Marketplace;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\Listing;
use App\Models\ListingModerationEvent;
use App\Models\ListingReport;
use App\Models\User;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;

/**
 * Reports in, decisions out.
 *
 * The one thing this file must get right: **a takedown stops distribution and
 * reaches nothing else.** It writes one status on one listing. It does not touch
 * `listing_installs`, it does not touch anybody's `decks` or `notes`, and there
 * is no code path here that could — a clone is the cloner's property, and a deck
 * being removed from sale is not a reason to delete a month of their scheduling
 * (PHASES §8).
 */
final readonly class ModerationService
{
    /**
     * How long a claim holds before anybody else may take the report.
     *
     * A soft lock with an expiry, not an assignment. The alternative is an
     * explicit release, which is the step everyone forgets — and a queue where
     * three reports are parked under somebody who went home is a queue that
     * quietly stops working.
     */
    public const CLAIM_MINUTES = 30;

    /**
     * File a report, or a publisher's counter-notice about their own takedown.
     *
     * One open report per person per listing per kind. The rate limit on the
     * route stops a flood; this stops the quieter version, where one person
     * files the same complaint forty times to make a queue look like a consensus.
     */
    public function report(?User $reporter, Listing $listing, string $kind, string $reason, ?string $detail): ListingReport
    {
        if ($kind === ListingReport::KIND_COUNTER_NOTICE && $reporter?->id !== $listing->user_id) {
            throw new ApiException(
                ApiErrorCode::Forbidden,
                'Only the publisher of a removed deck can file a counter-notice.',
            );
        }

        return DB::transaction(function () use ($reporter, $listing, $kind, $reason, $detail): ListingReport {
            $report = ListingReport::query()->firstOrNew([
                'listing_id' => $listing->id,
                'reporter_id' => $reporter?->id,
                'kind' => $kind,
                'status' => ListingReport::STATUS_OPEN,
            ]);

            if ($report->exists) {
                return $report;
            }

            $report->fill(['reason' => $reason, 'detail' => $detail])->save();
            $listing->increment('open_report_count');

            // A counter-notice is a step in the listing's history, not only an
            // item in a queue: reinstating a deck has to be readable afterwards
            // as an answer to something, and this is the row that says so.
            if ($kind === ListingReport::KIND_COUNTER_NOTICE) {
                $this->record($listing, null, ListingModerationEvent::ACTION_COUNTER_NOTICE, $detail);
            }

            return $report;
        });
    }

    /**
     * Down, now, with a reason on the record.
     *
     * Upholding every open report in the same transaction is what makes the
     * queue mean something: a listing that is removed while three reports about
     * it are still marked open reads, to the next moderator, as unhandled.
     */
    public function takedown(User $moderator, Listing $listing, string $reason): Listing
    {
        return DB::transaction(function () use ($moderator, $listing, $reason): Listing {
            $listing->forceFill([
                'status' => Listing::STATUS_REMOVED,
                'published_at' => null,
                'moderated_by' => $moderator->id,
                'moderated_at' => Carbon::now(),
                'moderation_reason' => $reason,
                'open_report_count' => 0,
            ])->save();

            $this->closeOpenReports($listing, $moderator, ListingReport::STATUS_UPHELD, $reason);
            $this->record($listing, $moderator, ListingModerationEvent::ACTION_TAKEDOWN, $reason);

            return $listing;
        });
    }

    /**
     * The middle setting PHASES §8 asks for between "fine" and "gone".
     *
     * A deck that is miscategorised, or wrong in a way that is nobody's fault,
     * should stop being *recommended* without being erased — the link keeps
     * working, existing clones update as before, and it leaves the catalogue.
     * Having only takedown is what makes moderators reach for takedown.
     */
    public function unlist(User $moderator, Listing $listing, string $reason): Listing
    {
        return DB::transaction(function () use ($moderator, $listing, $reason): Listing {
            $listing->forceFill([
                'visibility' => Listing::VISIBILITY_UNLISTED,
                'moderated_by' => $moderator->id,
                'moderated_at' => Carbon::now(),
                'moderation_reason' => $reason,
                'open_report_count' => 0,
            ])->save();

            $this->closeOpenReports($listing, $moderator, ListingReport::STATUS_UPHELD, $reason);
            $this->record($listing, $moderator, ListingModerationEvent::ACTION_UNLIST, $reason);

            return $listing;
        });
    }

    /**
     * Approve a first publication, or reinstate one that was taken down.
     *
     * Reinstating leaves upheld reports upheld — they are the history of a
     * decision that was made, and rewriting them would be rewriting the record
     * rather than adding to it.
     */
    public function approve(User $moderator, Listing $listing, ?string $note = null): Listing
    {
        return DB::transaction(function () use ($moderator, $listing, $note): Listing {
            $listing->forceFill([
                'status' => Listing::STATUS_PUBLISHED,
                'published_at' => $listing->published_at ?? Carbon::now(),
                'moderated_by' => $moderator->id,
                'moderated_at' => Carbon::now(),
                'moderation_reason' => $note,
                'open_report_count' => 0,
            ])->save();

            $this->closeOpenReports($listing, $moderator, ListingReport::STATUS_DISMISSED, $note);
            $this->record($listing, $moderator, ListingModerationEvent::ACTION_APPROVE, $note);

            return $listing;
        });
    }

    /** Dismiss one report without changing what the listing is doing. */
    public function dismiss(User $moderator, ListingReport $report, ?string $note = null): ListingReport
    {
        if ($report->status !== ListingReport::STATUS_OPEN) {
            return $report;
        }

        return DB::transaction(function () use ($moderator, $report, $note): ListingReport {
            $report->forceFill([
                'status' => ListingReport::STATUS_DISMISSED,
                'resolved_by' => $moderator->id,
                'resolved_at' => Carbon::now(),
                'resolution_note' => $note,
            ])->save();

            $this->record(
                $report->listing,
                $moderator,
                ListingModerationEvent::ACTION_DISMISS,
                $note,
            );

            Listing::query()
                ->whereKey($report->listing_id)
                ->where('open_report_count', '>', 0)
                ->decrement('open_report_count');

            return $report;
        });
    }

    /**
     * Append one row to the trail. Never updates, never deletes.
     *
     * `$moderator` is null for a publisher's own counter-notice, which is the
     * only event here that is not a moderator's act.
     */
    /**
     * Take a report, unless somebody else already has it.
     *
     * The update is conditional and atomic: `WHERE claimed_by IS NULL OR
     * claimed_at < expiry` decides the race in the database rather than in two
     * moderators' browsers, and the affected-row count is the answer. Reading
     * first and writing second would let both of them read "unclaimed".
     *
     * Re-claiming your own report is allowed and refreshes the hold, because
     * that is what a moderator still reading it is doing.
     */
    public function claim(User $moderator, ListingReport $report): bool
    {
        $expiry = Carbon::now()->subMinutes(self::CLAIM_MINUTES);

        $taken = ListingReport::query()
            ->where('id', $report->id)
            ->where('status', ListingReport::STATUS_OPEN)
            ->where(fn ($q) => $q
                ->whereNull('claimed_by')
                ->orWhere('claimed_by', $moderator->id)
                ->orWhere('claimed_at', '<', $expiry))
            ->update(['claimed_by' => $moderator->id, 'claimed_at' => Carbon::now()]);

        return $taken > 0;
    }

    /** Put it back. Explicit, for a moderator who looked and moved on. */
    public function release(User $moderator, ListingReport $report): void
    {
        ListingReport::query()
            ->where('id', $report->id)
            ->where('claimed_by', $moderator->id)
            ->update(['claimed_by' => null, 'claimed_at' => null]);
    }

    /** Whether a claim is somebody else's and still live. */
    public function heldByAnother(User $moderator, ListingReport $report): bool
    {
        return $report->claimed_by !== null
            && $report->claimed_by !== $moderator->id
            && $report->claimed_at !== null
            && $report->claimed_at->gt(Carbon::now()->subMinutes(self::CLAIM_MINUTES));
    }

    public function record(?Listing $listing, ?User $moderator, string $action, ?string $reason): void
    {
        if ($listing === null) {
            return;
        }

        ListingModerationEvent::query()->create([
            'listing_id' => $listing->id,
            'moderator_id' => $moderator?->id,
            'action' => $action,
            'resulting_status' => $listing->status,
            'reason' => $reason,
        ]);
    }

    private function closeOpenReports(Listing $listing, User $moderator, string $status, ?string $note): void
    {
        $listing->reports()
            ->where('status', ListingReport::STATUS_OPEN)
            ->update([
                'status' => $status,
                'resolved_by' => $moderator->id,
                'resolved_at' => Carbon::now(),
                'resolution_note' => $note,
                'updated_at' => Carbon::now(),
            ]);
    }
}
