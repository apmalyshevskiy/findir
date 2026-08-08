<?php

namespace App\Models\Tenant;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Facades\Crypt;

class Integration extends Model
{
    protected $table = 'integrations';

    protected $fillable = [
        'type', 'name', 'is_active', 'credentials', 'settings',
        'last_run_at', 'last_run_status', 'last_run_message',
    ];

    protected $casts = [
        'is_active'   => 'boolean',
        'settings'    => 'array',
        'last_run_at' => 'datetime',
    ];

    /**
     * Доступы наружу не отдаются никогда — ни в списке, ни в карточке.
     * Токен вводят один раз; после сохранения UI показывает только «задан».
     */
    protected $hidden = ['credentials'];

    /**
     * Расшифрованные доступы.
     *
     * Ошибку расшифровки не проглатываем: пустой массив выглядел бы как
     * «токен не введён», и человек ушёл бы вводить его заново вместо того,
     * чтобы узнать про сменившийся APP_KEY.
     */
    public function credentials(): array
    {
        if (!$this->credentials) return [];

        $json = Crypt::decryptString($this->credentials);
        return json_decode($json, true) ?: [];
    }

    public function setCredentials(array $values): void
    {
        $this->credentials = Crypt::encryptString(json_encode($values, JSON_UNESCAPED_UNICODE));
    }

    public function hasCredentials(): bool
    {
        return (bool) $this->credentials;
    }

    /** Настройка с значением по умолчанию. */
    public function setting(string $key, $default = null)
    {
        return data_get($this->settings, $key, $default);
    }

    public function runs(): HasMany
    {
        return $this->hasMany(IntegrationRun::class)->orderByDesc('id');
    }

    public function links(): HasMany
    {
        return $this->hasMany(IntegrationLink::class);
    }
}
