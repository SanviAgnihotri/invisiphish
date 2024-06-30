# ADR 0001: Neon instead of Supabase

**Status:** accepted

## Context

The original application was built against Supabase: Postgres plus its Auth
service plus Edge Functions. The project needed a serverless Postgres and a
managed authentication service, and the choice of provider determines how the
browser talks to the data.

## Decision

Use **Neon** for Postgres and **Neon Auth (Managed Better Auth)** for
authentication. The browser never talks to the database directly; every read
and write goes through a Vercel function that verifies the session and lets
Row Level Security decide what the caller may see.

## Consequences

* The browser holds **no** database URL and **no** API key. The only
  credential it has is an http-only session cookie that the browser cannot
  read.
* Row Level Security becomes a second line of defence rather than the only
  one, because the API already authorises the caller. The application role is
  explicitly created without `BYPASSRLS`; the owner role is reserved for
  migrations and is never used to serve a request.
* Neon Auth keeps users and sessions in the `neon_auth` schema of the same
  database, so identity and data branch together. That is useful for testing
  the whole auth flow in a throwaway branch.
* We lose Supabase Edge Functions and replace them with Vercel functions,
  which is one fewer platform to run.
* The `@neondatabase/neon-js` client is only published as a beta, so we do
  not depend on it. The server uses the stable `@neondatabase/serverless`
  driver and the browser uses Neon Auth's REST endpoints directly.
