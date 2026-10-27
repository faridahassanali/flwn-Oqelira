CREATE TABLE IF NOT EXISTS oq_projects (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  created_at timestamptz NOT NULL DEFAULT now(),
  active_run uuid,
  lease_until timestamptz,
  UNIQUE(user_id, id)
);
CREATE TABLE IF NOT EXISTS oq_conversations (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  project_id uuid NOT NULL,
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
  model text NOT NULL,
  messages jsonb NOT NULL DEFAULT '[]',
  status text NOT NULL DEFAULT 'ready',
  active_run uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id, project_id) REFERENCES oq_projects(user_id, id) ON DELETE CASCADE,
  UNIQUE(user_id, id)
);
CREATE INDEX IF NOT EXISTS oq_conversations_owner ON oq_conversations(user_id, project_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS oq_memory (
  id uuid PRIMARY KEY,
  user_id text NOT NULL,
  project_id uuid NOT NULL,
  content text NOT NULL CHECK(char_length(content) BETWEEN 1 AND 4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id, project_id) REFERENCES oq_projects(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oq_memory_owner ON oq_memory(user_id, project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS oq_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  action text NOT NULL,
  tool text,
  decision boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id, conversation_id) REFERENCES oq_conversations(user_id, id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS oq_quota (
  user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  bucket text NOT NULL,
  window_id bigint NOT NULL,
  used integer NOT NULL,
  PRIMARY KEY(user_id, bucket)
);

CREATE TABLE IF NOT EXISTS oq_run_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id text NOT NULL,
  conversation_id uuid NOT NULL,
  run_id uuid NOT NULL,
  event jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id, conversation_id) REFERENCES oq_conversations(user_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS oq_run_events_replay ON oq_run_events(user_id,run_id,sequence);

CREATE TABLE IF NOT EXISTS oq_account_mail (
 id uuid PRIMARY KEY,
 payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 locked_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE oq_projects ADD COLUMN IF NOT EXISTS organization_id text REFERENCES organization(id) ON DELETE CASCADE;
ALTER TABLE oq_audit ADD COLUMN IF NOT EXISTS actor_id text REFERENCES "user"(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS oq_projects_organization ON oq_projects(organization_id);
