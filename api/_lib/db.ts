/**
 * Server-side database access for the API routes.
 *
 * The browser never talks to the database. Every read and write goes through
 * an API route, which is where the session is verified and the authorization
 * decision is made. On top of that, the queries run inside a transaction that
 * carries the caller's verified identity in `request.jwt.claims`, so the Row
 * Level Security policies in `db/migrations` apply as well. Defence in depth:
 * the API checks *who* may act, and Postgres checks *what* they may see.
 *
 * A single role is used for the application traffic. It must NOT have the
 * BYPASSRLS attribute - the `neondb_owner` role does, and is reserved for
 * migrations and background jobs.
 */

import { Pool, neon } from '@neondatabase/serverless';

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Missing DATABASE_URL');

    pool = new Pool({ connectionString, max: 10 });
    pool.on('error', (error: Error) => console.error('[db] pool error:', error));
  }
  return pool;
}

/**
 * Run `work` inside a transaction in which the caller's identity is visible to
 * Row Level Security.
 */
export async function withUser<T>(
  userId: string,
  work: (client: import('@neondatabase/serverless').PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query('select set_config($1, $2, true)', [
      'request.jwt.claims',
      JSON.stringify({ sub: userId }),
    ]);

    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Administrative access, used for migrations and reference data such as the
 * mined pattern repository. This role bypasses RLS, so it is never used to
 * serve a request that carries user data.
 */
export function adminSql() {
  const connectionString = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('Missing DATABASE_ADMIN_URL');
  return neon(connectionString);
}

/** Close the pool (used by scripts and tests). */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

/**
 * Store the profile of a user.
 *
 * The organisation is application metadata rather than an auth field, so it is
 * only ever added, never overwritten: a sign-in must not clear it.
 */
export async function saveProfile(
  userId: string,
  email: string,
  name: string,
  organization: string | null,
): Promise<void> {
  await withUser(userId, async (client) => {
    await client.query(
      `insert into public.profiles (user_id, email, full_name, organization)
       values ($1, $2, $3, $4)
       on conflict (user_id) do update
         set email = excluded.email,
             full_name = excluded.full_name,
             organization = coalesce(excluded.organization, public.profiles.organization)`,
      [userId, email, name, organization],
    );
  }).catch((error) => console.warn('[auth] could not save profile:', error));
}
