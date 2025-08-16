CREATE SCHEMA IF NOT EXISTS discord_tags;

CREATE TABLE IF NOT EXISTS discord_tags.user_tags (
  discord_id   TEXT PRIMARY KEY,
  tag_number   INTEGER NOT NULL,
  is_staff_tag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- evitar números repetidos
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conname = 'uq_user_tags_tag'
  ) THEN
    ALTER TABLE discord_tags.user_tags
      ADD CONSTRAINT uq_user_tags_tag UNIQUE (tag_number);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION discord_tags.touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tg_user_tags_updated ON discord_tags.user_tags;
CREATE TRIGGER tg_user_tags_updated
BEFORE UPDATE ON discord_tags.user_tags
FOR EACH ROW EXECUTE FUNCTION discord_tags.touch_updated_at();
