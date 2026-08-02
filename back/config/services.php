<?php

return [

    /*
    |--------------------------------------------------------------------------
    | Third Party Services
    |--------------------------------------------------------------------------
    |
    | This file is for storing the credentials for third party services such
    | as Mailgun, Postmark, AWS and more. This file provides the de facto
    | location for this type of information, allowing packages to have
    | a conventional file to locate the various service credentials.
    |
    */

    'postmark' => [
        'key' => env('POSTMARK_API_KEY'),
    ],

    'resend' => [
        'key' => env('RESEND_API_KEY'),
    ],

    'ses' => [
        'key' => env('AWS_ACCESS_KEY_ID'),
        'secret' => env('AWS_SECRET_ACCESS_KEY'),
        'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
    ],

    'slack' => [
        'notifications' => [
            'bot_user_oauth_token' => env('SLACK_BOT_USER_OAUTH_TOKEN'),
            'channel' => env('SLACK_BOT_USER_DEFAULT_CHANNEL'),
        ],
    ],

    /*
    | RouterAI — OpenAI-совместимый шлюз к моделям (routerai.ru).
    | Модели вынесены в env, чтобы сравнивать качество/цену без правки кода.
    */
    'routerai' => [
        'key'         => env('ROUTERAI_API_KEY'),
        'base_url'    => env('ROUTERAI_BASE_URL', 'https://routerai.ru/api/v1'),
        'model'       => env('ROUTERAI_MODEL', 'anthropic/claude-sonnet-5'),
        'model_stt'   => env('ROUTERAI_MODEL_STT', 'fish-audio/transcribe-1'),
        'timeout'     => (int) env('ROUTERAI_TIMEOUT', 60),
    ],

];
