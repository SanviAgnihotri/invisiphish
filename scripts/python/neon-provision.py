#!/usr/bin/env python3
"""
Provision the InvisiPhish Neon project end to end.

Creates the project, creates a restricted application role that does **not**
have `BYPASSRLS`, enables Neon Auth, applies the migrations in `db/migrations`
and prints the environment variables to put in `.env.local`.

The script is idempotent: running it again reuses an existing project.

Requirements:
    export NEON_API_KEY=...        # console.neon.tech -> Account settings -> API keys
    pip install psycopg[binary] requests

Usage:
    python scripts/python/neon-provision.py --name invisiphish --region aws-us-east-1
    python scripts/python/neon-provision.py --dry-run     # show the plan, change nothing
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

API_BASE = "https://console.neon.tech/api/v2"
ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "db" / "migrations"


def api(path: str, method: str = "GET", body: dict | None = None) -> dict:
    key = os.environ.get("NEON_API_KEY")
    if not key:
        raise SystemExit("NEON_API_KEY is not set. Create one at console.neon.tech/account/api-keys")

    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(
        f"{API_BASE}{path}",
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            payload = response.read().decode()
            return json.loads(payload) if payload else {}
    except urllib.error.HTTPError as error:
        detail = error.read().decode()[:600]
        raise SystemExit(f"{method} {path} failed with {error.code}:\n{detail}") from error


def find_project(name: str) -> dict | None:
    listing = api("/projects?limit=200")
    for project in listing.get("projects", []):
        if project.get("name") == name:
            return project
    return None


def create_project(name: str, region: str, pg_version: int) -> dict:
    print(f"  creating project {name!r} in {region}")
    response = api(
        "/projects",
        method="POST",
        body={
            "project": {
                "name": name,
                "region_id": region,
                "pg_version": pg_version,
            }
        },
    )
    return response["project"]


def wait_for_operations(project_id: str, timeout: int = 300) -> None:
    """Neon creates resources asynchronously; wait until the project is ready."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        details = api(f"/projects/{project_id}")
        operations = details.get("operations", [])
        pending = [
            operation
            for operation in operations
            if operation.get("status") not in {"finished", "ready", "error", "aborted"}
        ]
        if not pending:
            return
        time.sleep(3)
    print("  warning: timed out waiting for Neon operations to finish", file=sys.stderr)


def default_branch(project: dict) -> dict:
    branches = api(f"/projects/{project['id']}/branches")["branches"]
    for branch in branches:
        if branch.get("is_default"):
            return branch
    return branches[0]


def ensure_role(project_id: str, role_name: str) -> None:
    existing = {role["name"] for role in api(f"/projects/{project_id}/roles")["roles"]}
    if role_name in existing:
        print(f"  role {role_name!r} already exists")
        return

    print(f"  creating application role {role_name!r}")
    api(
        f"/projects/{project_id}/roles",
        method="POST",
        body={"role": {"name": role_name}},
    )


def connection_uri(project_id: str, branch_id: str, database: str, role: str, pooled: bool) -> str:
    query = f"database_name={database}&role_name={role}&pooled={'true' if pooled else 'false'}"
    return api(f"/projects/{project_id}/connection_uri?{query}")["uri"]


def enable_auth(project_id: str, branch_id: str) -> str | None:
    """Enable Neon Auth and return the auth service URL."""
    try:
        response = api(f"/projects/{project_id}/branches/{branch_id}/auth", method="POST")
    except SystemExit as error:
        print(f"  could not enable Neon Auth automatically: {error}")
        print("  enable it manually in the Neon console under Auth.")
        return None

    endpoints = response.get("endpoints", [])
    for endpoint in endpoints:
        url = endpoint.get("host") or endpoint.get("url")
        if url:
            return url if url.startswith("http") else f"https://{url}"
    return None


def apply_migrations(admin_uri: str, role_name: str) -> None:
    try:
        import psycopg
    except ImportError:
        print("  psycopg is not installed, skipping migrations (pip install 'psycopg[binary]')")
        return

    files = sorted(MIGRATIONS.glob("*.sql"))
    with psycopg.connect(admin_uri, autocommit=True) as connection:
        for file in files:
            print(f"  applying {file.name}")
            connection.execute(file.read_text(encoding="utf-8"))

        # The application role gets ordinary table privileges and no BYPASSRLS,
        # so Row Level Security is what actually limits what a user can read.
        connection.execute(f"grant usage on schema app to {role_name}")
        connection.execute(
            f"grant select, insert, update, delete on all tables in schema public to {role_name}"
        )
        connection.execute(f"grant usage, select on all sequences in schema public to {role_name}")
        connection.execute(
            f"alter default privileges in schema public "
            f"grant select, insert, update, delete on tables to {role_name}"
        )
        connection.execute(
            f"alter default privileges in schema public grant usage, select on sequences to {role_name}"
        )

        row = connection.execute(
            "select rolbypassrls, rolsuper from pg_roles where rolname = %s",
            (role_name,),
        ).fetchone()
        if row and (row[0] or row[1]):
            print(
                f"  ERROR: role {role_name!r} bypasses RLS. The policies would not apply.",
                file=sys.stderr,
            )
            raise SystemExit(1)
        print(f"  role {role_name!r} verified: RLS is enforced for it")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="invisiphish")
    parser.add_argument("--region", default="aws-us-east-1")
    parser.add_argument("--pg-version", type=int, default=17)
    parser.add_argument("--database", default="neondb")
    parser.add_argument("--app-role", default="invisiphish_app")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    if args.dry_run:
        print("Would do:")
        print(f"  1. find or create the Neon project {args.name!r} in {args.region}")
        print(f"  2. create the restricted role {args.app_role!r} (no BYPASSRLS)")
        print(f"  3. enable Neon Auth on the default branch")
        print(f"  4. apply {len(list(MIGRATIONS.glob('*.sql')))} migration(s)")
        print(f"  5. print the .env.local block")
        return 0

    print("== Neon provisioning ==")
    project = find_project(args.name)
    if project is None:
        project = create_project(args.name, args.region, args.pg_version)
        print(f"  created project {project['id']}")
    else:
        print(f"  reusing project {project['id']}")

    wait_for_operations(project["id"])

    branch = default_branch(project)
    print(f"  default branch: {branch['id']}")

    ensure_role(project["id"], args.app_role)
    wait_for_operations(project["id"])

    admin_uri = connection_uri(project["id"], branch["id"], args.database, "neondb_owner", False)
    app_uri = connection_uri(project["id"], branch["id"], args.database, args.app_role, True)

    auth_url = enable_auth(project["id"], branch["id"])

    print("\n== applying migrations ==")
    apply_migrations(admin_uri, args.app_role)

    print("\n== .env.local ==")
    print(f"DATABASE_URL={app_uri}")
    print(f"DATABASE_ADMIN_URL={admin_uri}")
    if auth_url:
        print(f"NEON_AUTH_BASE_URL={auth_url}")
    else:
        print("NEON_AUTH_BASE_URL=<copy from the Neon console>")
    print("MODEL_DIR=./public/models/")
    print("GEMINI_API_KEY=")
    print("GEMINI_MODEL=gemini-3.8-flash")
    print()
    print("Project id:", project["id"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
