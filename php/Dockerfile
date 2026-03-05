ARG PHP_VERSION=8.3
FROM php:${PHP_VERSION}-fpm-alpine

# ── Системные зависимости ──────────────────────────────────────────
RUN apk add --no-cache \
    bash \
    git \
    curl \
    unzip \
    libzip-dev \
    libpng-dev \
    libjpeg-turbo-dev \
    freetype-dev \
    icu-dev \
    oniguruma-dev \
    libxml2-dev \
    linux-headers \
    $PHPIZE_DEPS

# ── PHP расширения ─────────────────────────────────────────────────
RUN docker-php-ext-configure gd --with-freetype --with-jpeg \
 && docker-php-ext-install -j$(nproc) \
    pdo_mysql \
    mbstring \
    exif \
    pcntl \
    bcmath \
    gd \
    zip \
    intl \
    opcache \
    xml \
    sockets

# ── Redis расширение ───────────────────────────────────────────────
RUN pecl install redis \
 && docker-php-ext-enable redis

# ── Composer ──────────────────────────────────────────────────────
COPY --from=composer:2.7 /usr/bin/composer /usr/bin/composer

# ── Рабочая директория ────────────────────────────────────────────
WORKDIR /var/www/html

# ── Пользователь (не root) ────────────────────────────────────────
RUN addgroup -g 1000 -S www \
 && adduser -u 1000 -S www -G www

# ── OPcache конфиг (продакшн) ─────────────────────────────────────
RUN echo "opcache.enable=1" >> /usr/local/etc/php/conf.d/opcache.ini \
 && echo "opcache.memory_consumption=256" >> /usr/local/etc/php/conf.d/opcache.ini \
 && echo "opcache.max_accelerated_files=20000" >> /usr/local/etc/php/conf.d/opcache.ini \
 && echo "opcache.validate_timestamps=0" >> /usr/local/etc/php/conf.d/opcache.ini \
 && echo "opcache.revalidate_freq=0" >> /usr/local/etc/php/conf.d/opcache.ini

USER www

EXPOSE 9000

CMD ["php-fpm"]
