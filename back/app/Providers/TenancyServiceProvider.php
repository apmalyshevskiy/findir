<?php

namespace App\Providers;

use Illuminate\Support\ServiceProvider;
use Illuminate\Support\Facades\Event;
use Stancl\Tenancy\Events;
use Stancl\Tenancy\Listeners;

class TenancyServiceProvider extends ServiceProvider
{
    public function register(): void {}

    public function boot(): void
    {
        Event::listen(
            Events\TenancyInitialized::class,
            Listeners\BootstrapTenancy::class
        );
        Event::listen(
            Events\TenancyEnded::class,
            Listeners\RevertToCentralContext::class
        );
    }
}
