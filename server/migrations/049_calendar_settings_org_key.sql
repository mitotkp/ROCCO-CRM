-- 049: clave de calendar_settings por (usuario, organización).
-- El código guarda los ajustes con ON CONFLICT (user_id, organization_id), pero las migraciones
-- dejaban la tabla con PRIMARY KEY (user_id): en una BD creada desde cero, conectar Google
-- Calendar o Zoom y guardar el horario fallaban con 42P10 (no hay restricción que coincida).
-- Idempotente: si la BD ya tiene esa clave (puesta a mano en su día), no hace nada.

-- Filas anteriores a la columna organization_id: toman la organización de su usuario
UPDATE calendar_settings cs
SET organization_id = u.organization_id
FROM users u
WHERE cs.organization_id IS NULL AND u.id = cs.user_id;

DO $$
DECLARE
  pk_name TEXT;
  pk_cols TEXT[];
BEGIN
  -- ¿Ya hay un índice único exactamente sobre (user_id, organization_id), en cualquier orden?
  IF EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indrelid = 'calendar_settings'::regclass AND i.indisunique AND i.indpred IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
           FROM pg_attribute a WHERE a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey))
          = ARRAY['organization_id', 'user_id']
  ) THEN
    RETURN;
  END IF;

  SELECT c.conname, array_agg(a.attname::text)
  INTO pk_name, pk_cols
  FROM pg_constraint c
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
  WHERE c.conrelid = 'calendar_settings'::regclass AND c.contype = 'p'
  GROUP BY c.conname;

  -- Clave antigua solo por usuario: pasa a (usuario, organización), una fila por cuenta
  IF pk_cols = ARRAY['user_id'] AND NOT EXISTS (SELECT 1 FROM calendar_settings WHERE organization_id IS NULL) THEN
    EXECUTE format('ALTER TABLE calendar_settings DROP CONSTRAINT %I', pk_name);
    ALTER TABLE calendar_settings ADD PRIMARY KEY (user_id, organization_id);
  ELSE
    CREATE UNIQUE INDEX calendar_settings_user_org_key ON calendar_settings (user_id, organization_id);
  END IF;
END $$;
