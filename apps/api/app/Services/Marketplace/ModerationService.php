<?php

declare(strict_types=1);

namespace App\Services\Marketplace;

use App\Enums\ApiErrorCode;
use App\Exceptions\ApiException;
use App\Models\Listing;
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

            Listing::query()
                ->whereKey($report->listing_id)
                ->where('open_report_count', '>', 0)
                ->decrement('open_report_count');

            return $report;
        });
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
