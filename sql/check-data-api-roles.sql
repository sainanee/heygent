-- Run in a Supabase project's SQL editor after the app's first deploy. Two results:
--   tables: how many tables schema public has (Parley's; 0 means the app has not deployed, and the second result
--           proves nothing yet);
--   exposed: one row per table and API role that still holds any table privilege. It must return no rows.
SELECT count(*) AS tables FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');

SELECT c.relname AS table_name, r.role
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN unnest(ARRAY['anon', 'authenticated']) AS r(role)
WHERE n.nspname = 'public'
  AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
  AND has_table_privilege(r.role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER');
