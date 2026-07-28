-- ══════════════════════════════════════════════════════════════════
--  FINDIR — инициализация внешней MariaDB (выполнить под root ОДИН раз)
--  mysql -u root -p < deploy/db-init.sql   (заменив CHANGE_ME на пароль)
-- ══════════════════════════════════════════════════════════════════

-- Центральная база (тенанты, personal_access_tokens)
CREATE DATABASE IF NOT EXISTS findir_central
    CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Пользователь приложения. '%' — т.к. подключение идёт из docker-сети
-- (host.docker.internal → шлюз 172.x). Ограничьте доступ файрволом!
CREATE USER IF NOT EXISTS 'findir'@'%' IDENTIFIED BY 'CHANGE_ME';

-- Права на центральную базу
GRANT ALL PRIVILEGES ON findir_central.* TO 'findir'@'%';

-- Права на ВСЕ базы тенантов (findir_<slug>).
-- Шаблон `findir\_%` позволяет пользователю и СОЗДАВАТЬ такие базы —
-- это нужно, т.к. при регистрации компании приложение делает CREATE DATABASE.
GRANT ALL PRIVILEGES ON `findir\_%`.* TO 'findir'@'%';

FLUSH PRIVILEGES;

-- ── После этого проверьте, что MariaDB слушает docker-интерфейс: ──
--   [mysqld] bind-address = 0.0.0.0   (или 172.17.0.1 — docker0)
--   и порт 3306 закрыт снаружи файрволом (ufw deny 3306 / allow from 172.16.0.0/12)
