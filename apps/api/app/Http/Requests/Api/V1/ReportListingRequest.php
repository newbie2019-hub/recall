<?php

declare(strict_types=1);

namespace App\Http\Requests\Api\V1;

use App\Models\ListingReport;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * A report, or a publisher's counter-notice.
 *
 * Both intake paths PHASES §8 asks for share this shape: the Copyright Act 1968
 * and DMCA differ in what the sender must state, not in what the form collects,
 * and `detail` is where that statement goes.
 */
class ReportListingRequest extends FormRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'kind' => ['sometimes', Rule::in([ListingReport::KIND_REPORT, ListingReport::KIND_COUNTER_NOTICE])],
            'reason' => ['required', Rule::in(ListingReport::REASONS)],
            'detail' => ['nullable', 'string', 'max:4000'],
        ];
    }

    public function kind(): string
    {
        return $this->input('kind', ListingReport::KIND_REPORT);
    }
}
