-- 048: vínculo explícito entre un admin de agencia y su usuario del CRM.
-- Antes el acceso de agencia desde el login del CRM se daba por coincidencia de email: el admin
-- de cualquier cuenta podía crear un usuario con el email de un admin de agencia (y la contraseña
-- que quisiera) y obtener así un token de agencia. Ahora solo vale el usuario enlazado aquí.
--
-- No se rellena por email a propósito: copiar las coincidencias actuales daría por bueno un
-- usuario creado con ese truco. Cada vínculo se da de alta a mano tras comprobar que el usuario
-- del CRM es de verdad del admin:
--   UPDATE agency_admins SET user_id = '<id del usuario>' WHERE email = '<email del admin>';

ALTER TABLE agency_admins
  ADD COLUMN IF NOT EXISTS user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL;
