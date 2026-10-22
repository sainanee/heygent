-- Run once per Supabase project, in the SQL editor (as postgres), before the app's first deploy; re-running is
-- harmless. Defence in depth behind turning the Data API off (runbooks/deploy.md, step 2): Supabase's API roles
-- (anon, authenticated) lose every privilege on schema public, and tables, sequences and functions that postgres
-- creates there later (Parley's, at every start) are not granted to them. The postgres role, which the server uses,
-- keeps everything: it owns what it creates, and nothing here is revoked from it. (PUBLIC keeps its default USAGE on
-- the schema, which reaches no table; functions lose PUBLIC's default EXECUTE, which their owner, postgres, keeps.)
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated, PUBLIC;
REVOKE USAGE, CREATE ON SCHEMA public FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
-- PUBLIC's EXECUTE on new functions is a built-in default, and a per-schema default (IN SCHEMA public) can only add to
-- the built-in ones, never take them away (PostgreSQL's ALTER DEFAULT PRIVILEGES). So this one has no IN SCHEMA: it
-- covers functions postgres creates in any schema from now on. Such functions stay executable by their owner, and by
-- any role granted EXECUTE on them explicitly.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
