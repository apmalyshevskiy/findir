-- ══════════════════════════════════════════════════════════════════
--  FINDIR — MariaDB init script
--  Выполняется один раз при первом запуске контейнера
-- ══════════════════════════════════════════════════════════════════

-- Права для основного пользователя: может управлять всеми БД findir_*
-- (центральная findir_central + тенантные findir_{slug})
-- TenantService::dbName() формирует имена как findir_{slug_с_подчёркиваниями}
GRANT ALL PRIVILEGES ON `findir\_%`.* TO 'findir'@'%';

-- Отдельный пользователь только для чтения (read-replica / аналитика)
CREATE USER IF NOT EXISTS 'findir_ro'@'%' IDENTIFIED BY 'change_me_readonly';
GRANT SELECT ON `findir\_%`.* TO 'findir_ro'@'%';

FLUSH PRIVILEGES;
