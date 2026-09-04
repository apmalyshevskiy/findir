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
        // Для картинок нужна vision-модель: deepseek изображения не распознаёт
        'model_vision' => env('ROUTERAI_MODEL_VISION', 'anthropic/claude-sonnet-5'),
        'model_stt'   => env('ROUTERAI_MODEL_STT', 'fish-audio/transcribe-1'),
        // Разбор PDF на стороне RouterAI: cloudflare-ai — бесплатно (текстовые PDF),
        // mistral-ocr — сканы с распознаванием (~450 ₽ за 1000 страниц), native — моделью.
        'pdf_engine'  => env('ROUTERAI_PDF_ENGINE', 'cloudflare-ai'),
        'timeout'     => (int) env('ROUTERAI_TIMEOUT', 60),
        // Наценка на расход ИИ при показе тенанту, в процентах. Ноль — тенант
        // видит себестоимость. В журнал пишется всегда себестоимость: наценка
        // применяется при показе, чтобы её смена не переписывала историю
        'markup'      => (float) env('ROUTERAI_MARKUP', 0),
        // Валюту шлюз в usage не присылает, а стоимость присылает. По порядку
        // величины это рубли: вызов на 5 тысяч токенов deepseek обошёлся в
        // 0,158 — в долларах столько стоила бы сотня таких запросов
        'currency'    => env('ROUTERAI_CURRENCY', 'RUB'),
    ],

];
