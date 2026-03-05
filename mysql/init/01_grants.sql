-- ══════════════════════════════════════════════════════════════════
--  FINDIR — MySQL init script
--  Выполняется один раз при первом запуске контейнера
-- ══════════════════════════════════════════════════════════════════

-- Права для основного пользователя: может создавать tenant БД
-- stancl/tenancy создаёт БД вида findir_tenant_{id} автоматически
GRANT ALL PRIVILEGES ON `findir_%`.* TO 'findir'@'%';

-- Отдельный пользователь только для чтения (read-replica / аналитика)
CREATE USER IF NOT EXISTS 'findir_ro'@'%' IDENTIFIED BY 'change_me_readonly';
GRANT SELECT ON `findir_%`.* TO 'findir_ro'@'%';

FLUSH PRIVILEGES;
