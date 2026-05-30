<?php

namespace App\Services;

/**
 * Канонический список категорий платежа (ступень 1 — классификация).
 *
 * Категории НЕ зависят от тенанта: они одинаковы для всех. Универсальные
 * правила классификации выдают именно категорию (а не id счёта/статьи),
 * поэтому они переносимы между тенантами.
 *
 * Привязка категории к конкретному счёту и статье ДДС — это ступень 2
 * (карта разноски, таблица category_postings в БД тенанта).
 *
 * Заводим по одному виду операции. Сейчас активна только TRANSFER.
 */
final class PaymentCategory
{
    /** Перемещение денег между своими счетами (ИНН плательщика == ИНН получателя) */
    public const TRANSFER = 'TRANSFER';

    /** Налоги и взносы (заполнен КБК / статус составителя) — шаг 3 */
    public const TAX = 'TAX';

    /** Комиссия эквайринга ) */
    public const ACQUIRING_FEE = 'ACQUIRING_FEE';
    
    /** <анка (расход, контрагент-банк) — шаг 2 */
    public const BANK_SERVICE = 'BANK_SERVICE';

    /** Выручка от клиента, включая эквайринг-поступления — шаг 4 */
    public const CUSTOMER_PAYMENT = 'CUSTOMER_PAYMENT';

    /** Оплата поставщику — позже */
    public const SUPPLIER_PAYMENT = 'SUPPLIER_PAYMENT';

    /** Зарплата — на будущее */
    public const SALARY = 'SALARY';

    /** Займы и кредиты — на будущее */
    public const LOAN = 'LOAN';

    /** Правило не сработало → требуется ручная разметка */
    public const OTHER = 'OTHER';

    /** Все известные категории (для валидации значений в карте разноски) */
    public const ALL = [
        self::TRANSFER,
        self::TAX,
        self::ACQUIRING_FEE,
         self::BANK_SERVICE,
        self::CUSTOMER_PAYMENT,
        self::SUPPLIER_PAYMENT,
        self::SALARY,
        self::LOAN,
        self::OTHER,
    ];

    public static function isValid(?string $category): bool
    {
        return $category !== null && in_array($category, self::ALL, true);
    }
}
