<?php

use Illuminate\Foundation\Inspiring;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Schedule;

Artisan::command('inspire', function () {
    $this->comment(Inspiring::quote());
})->purpose('Display an inspiring quote');

/*
 * Nightly, and with overlap protection because a prune over a large log can run
 * long and two of them racing would each delete rows the other is counting.
 * 03:00 local: late enough that a study session is unlikely, early enough that
 * whoever opens a deck in the morning gets the pruned log.
 */
Schedule::command('collab:compact')
    ->dailyAt('03:00')
    ->withoutOverlapping()
    ->onOneServer();
