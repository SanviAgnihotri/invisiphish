#!/usr/bin/env python3
"""
Provision the Neon database for InvisiPhish from a connection string.

This is the SQL half of `scripts/python/neon-provision.py`. That script drives the
Neon console API, which needs a Neon API key; this one needs only the owner
connection string, so it can be run from a checkout that has the database but
not the API key.

It does the same work:

1. create the restricted application role, without BYPASSRLS,
2. apply every migration in `db/migrations`,
3. give the role ordinary table privileges,
4. verify that the role really is subject to Row Level Security,
5. write `.env.local`.

The Neon HTTP API only speaks the extended query protocol, which refuses a
script with several statements, so the SQL is run with `psql` - the same
client `research/ml/apply_migrations.py` uses through psycopg.

Usage:
    python3 scripts/python/provision-neon-local.py
    DATABASE_ADMIN_URL=postgresql://... python3 scripts/python/provision-neon-local.py
"""

from __future__ import annotations

import base64
import json
import os
import re
import secrets
import subprocess
import sys
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "db" / "migrations"
ENV_PATH = ROOT / ".env.local"
APP_ROLE = "invisiphish_app"
SECRET_DIR = Path.home() / ".t3" / "userdata" / "secrets"


def owner_connection_string() -> str:
    """The owner connection string, from the environment or the secret store."""
    value = os.environ.get("DATABASE_ADMIN_URL") or os.environ.get("DATABASE_URL")
    if value:
        return value.strip()

    if not SECRET_DIR.is_dir():
        raise SystemExit("No DATABASE_ADMIN_URL and no secret store to read it from.")

    candidates = []
    for path in SECRET_DIR.glob("secret-request-*.bin"):
        if "salt" in path.name:
            continue
        try:
            stored = json.loads(path.read_text(encoding="utf-8"))["value"].strip()
        except (ValueError, KeyError, OSError):
            continue
        if stored.startswith("postgres"):
            candidates.append((path.stat().st_mtime, stored))

    if not candidates:
        raise SystemExit("No postgres connection string found in the secret store.")

    candidates.sort(reverse=True)
    return candidates[0][1]


def parts(connection_string: str) -> urllib.parse.ParseResult:
    return urllib.parse.urlparse(connection_string)


def direct_host(hostname: str) -> str:
    """The unpooled host. The pooled host speaks the wire protocol only."""
    return hostname.replace("-pooler.", ".")


def build_url(
    connection_string: str,
    user: str,
    password: str,
    *,
    pooled: bool = False,
) -> str:
    url = parts(connection_string)
    hostname = url.hostname if pooled else direct_host(url.hostname)
    netloc = f"{user}:{urllib.parse.quote(password, safe='')}@{hostname}"
    if url.port:
        netloc += f":{url.port}"
    query = urllib.parse.urlencode({"sslmode": "require"})
    return urllib.parse.urlunparse((url.scheme, netloc, url.path or "/neondb", "", query, ""))


def psql(connection_string: str, sql: str, *, quiet: bool = True) -> str:
    result = subprocess.run(
        ["psql", connection_string, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-F", "|", "-c", sql],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit(f"psql failed:\n{result.stderr.strip()[:800]}")
    if not quiet and result.stdout.strip():
        print(result.stdout.strip())
    return result.stdout.strip()


def main() -> int:
    print("== InvisiPhish Neon provisioning ==")

    owner = owner_connection_string()
    url = parts(owner)
    owner_password = urllib.parse.unquote(url.password or "")
    if not owner_password:
        raise SystemExit("The connection string has no password.")

    admin_url = build_url(owner, url.username or "neondb_owner", owner_password)

    who = psql(admin_url, "select current_user")
    print(f"  connected as {who}")

    # --- the restricted application role ---------------------------------
    app_password = base64.urlsafe_b64encode(secrets.token_bytes(24)).decode().rstrip("=")
    roles = psql(
        admin_url,
        f"select rolname from pg_roles where rolname = '{APP_ROLE}'",
    )
    if roles:
        # The password is rotated with ALTER ROLE. The SUPERUSER attribute is
        # deliberately left out of the statement: only a role with the
        # SUPERUSER attribute may change it, and `neondb_owner` does not have
        # it - so `alter role ... nosuperuser` is refused even though the
        # attribute is already false. It cannot be true either: the only way
        # this role comes into being is `create role ... nosuperuser`, and a
        # non-superuser may not create a superuser role. The attribute is
        # asserted below instead of being set. `nobypassrls` is accepted, and
        # is the one that actually matters, because RLS is what limits what a
        # signed-in user can read.
        psql(
            admin_url,
            f"alter role {APP_ROLE} with login password '{app_password}' nobypassrls",
        )
        print(f"  role {APP_ROLE} existed; password rotated, BYPASSRLS revoked")
    else:
        psql(
            admin_url,
            f"create role {APP_ROLE} login password '{app_password}' "
            "nosuperuser nobypassrls noinherit",
        )
        print(f"  created role {APP_ROLE} (no BYPASSRLS)")

    # --- the roles the policies are written for ----------------------------
    # The migrations write their policies `to authenticated`, which is the
    # group role a request's identity belongs to. Neon normally creates it
    # with the project; a project created without it needs it here.
    for group_role in ("authenticated", "anonymous"):
        if not psql(admin_url, f"select rolname from pg_roles where rolname = '{group_role}'"):
            psql(admin_url, f"create role {group_role} nologin")
            print(f"  created group role {group_role}")

    psql(admin_url, f"grant authenticated to {APP_ROLE}")
    print(f"  {APP_ROLE} is a member of authenticated, so the RLS policies apply to it")

    # --- the migrations ----------------------------------------------------
    for file in sorted(MIGRATIONS.glob("*.sql")):
        result = subprocess.run(
            ["psql", admin_url, "-v", "ON_ERROR_STOP=1", "-q", "-f", str(file)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise SystemExit(f"applying {file.name} failed:\n{result.stderr.strip()[:800]}")
        print(f"  applied {file.name}")

    # --- the privileges ----------------------------------------------------
    psql(admin_url, f"grant usage on schema app to {APP_ROLE}")
    psql(
        admin_url,
        f"grant select, insert, update, delete on all tables in schema public to {APP_ROLE}",
    )
    psql(admin_url, f"grant usage, select on all sequences in schema public to {APP_ROLE}")
    psql(
        admin_url,
        "alter default privileges in schema public "
        f"grant select, insert, update, delete on tables to {APP_ROLE}",
    )
    psql(
        admin_url,
        "alter default privileges in schema public "
        f"grant usage, select on sequences to {APP_ROLE}",
    )

    # --- the verification the provisioning insists on ----------------------
    role = psql(
        admin_url,
        f"select rolbypassrls, rolsuper from pg_roles where rolname = '{APP_ROLE}'",
    )
    if role.strip() not in ("f|f", "f|f|"):
        raise SystemExit(f"{APP_ROLE} bypasses RLS; the policies would be decorative.")
    print(f"  verified {APP_ROLE}: RLS is enforced for it")

    tables = psql(
        admin_url,
        "select table_name from information_schema.tables "
        "where table_schema = 'public' order by 1",
    )
    print(f"  public tables: {', '.join(tables.split())}")

    policies = psql(
        admin_url,
        "select tablename || ': ' || policyname from pg_policies "
        "where schemaname = 'public' order by 1",
    )
    print(f"  RLS policies: {len(policies.splitlines())}")

    # --- .env.local --------------------------------------------------------
    # Every key that is already in the file is carried over, not only the
    # ones this script knows about. The file is written from scratch here,
    # because the application role's password changes on every run, and a
    # script that rewrote it with a fixed list of keys would silently delete
    # everything else - the model key and the model chain among them, which
    # would leave the explanation layer falling back to its deterministic
    # summary with nothing in the log to say why.
    previous = ENV_PATH.read_text(encoding="utf-8") if ENV_PATH.exists() else ""

    carried: dict[str, str] = {}
    for line in previous.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        carried[key.strip()] = value.strip()

    def keep(key: str, fallback: str = "") -> str:
        return carried.get(key, fallback)

    app_url = build_url(owner, APP_ROLE, app_password)

    # The keys this script owns, and their values.
    managed: dict[str, str] = {
        "DATABASE_URL": app_url,
        "DATABASE_ADMIN_URL": admin_url,
    }

    # Everything else the file already had, in the order it had it, with the
    # managed keys written last so they win.
    for key, value in carried.items():
        if key not in managed:
            managed[key] = value

    managed.setdefault("NEON_AUTH_BASE_URL", "")
    managed.setdefault("GEMINI_API_KEY", "")
    managed.setdefault("GEMINI_MODEL", "gemini-3.8-flash")
    managed.setdefault("MODEL_DIR", "./public/models/")

    block = "\n".join(
        [
            "# Neon (Postgres). DATABASE_URL must use a role WITHOUT BYPASSRLS.",
            f"DATABASE_URL={managed.pop('DATABASE_URL')}",
            f"DATABASE_ADMIN_URL={managed.pop('DATABASE_ADMIN_URL')}",
            "",
            "# The rest of the configuration is carried over from the previous file.",
            *[
                f"{key}={value}"
                for key, value in managed.items()
                if key not in ("NEON_AUTH_BASE_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "MODEL_DIR")
            ],
            "",
            f"NEON_AUTH_BASE_URL={keep('NEON_AUTH_BASE_URL')}",
            f"GEMINI_API_KEY={keep('GEMINI_API_KEY')}",
            f"GEMINI_MODEL={keep('GEMINI_MODEL', 'gemini-3.8-flash')}",
            f"MODEL_DIR={keep('MODEL_DIR', './public/models/')}",
            "",
        ]
    )
    ENV_PATH.write_text(block, encoding="utf-8")
    ENV_PATH.chmod(0o600)

    print(f"  wrote {ENV_PATH} (mode 600); the role password was not printed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
