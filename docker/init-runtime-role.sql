-- Docker init executes this only for a new empty database. Rotations use the
-- documented operator procedure; restarting a container never resets passwords.
DO $$ BEGIN
  EXECUTE format('CREATE ROLE agency_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', trim(pg_read_file('/run/secrets/db_app_password')));
END $$;
GRANT CONNECT, CREATE ON DATABASE agency TO agency_app;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
