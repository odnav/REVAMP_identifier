-- Schema e dados para tags permanentes
CREATE SCHEMA IF NOT EXISTS discord_tags;

-- sequência para público (>=100)
CREATE SEQUENCE IF NOT EXISTS discord_tags.public_seq START 100;

-- sequência para staff (<100)
CREATE SEQUENCE IF NOT EXISTS discord_tags.staff_seq START 1;

-- tabela principal
CREATE TABLE IF NOT EXISTS discord_tags.user_tags (
  discord_id   TEXT PRIMARY KEY,
  tag_number   INTEGER NOT NULL,
  is_staff_tag BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- função e trigger para updated_at
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
