# VeoveoAI Fork

This fork carries Veoveo changes on the `veoveo` branch over an upstream n8n release
(`upstream` = `https://github.com/n8n-io/n8n`).

- Current upstream base: release `n8n@2.46.0` (`17d3934e42`).
- Each change is the smallest one that closes a verified gap. Changes stay in this fork;
  they are not offered upstream.
- Update this file whenever a fork change is added, changed or retired.

## Updating To A New Release

1. Fetch the release tag from `upstream` and replay the changes below onto it in a new
   branch.
2. For each change, first check whether upstream now does the same. If it does, drop the
   change and record that here.
3. Run each change's check, then update the base above.

## Carried

### Schema check before `CREATE SCHEMA`

- `packages/@n8n/typeorm/src/driver/postgres/PostgresDriver.ts`: `afterConnect` checks
  `pg_catalog.pg_namespace` for the configured schema and runs
  `CREATE SCHEMA IF NOT EXISTS` only when the schema is missing.
- Why: PostgreSQL checks the CREATE privilege on the database before it applies
  `IF NOT EXISTS`. A Veoveo server's login owns its schema through its group role and
  has no CREATE privilege on the database, so unmodified n8n cannot connect: it stays
  at "Initializing n8n process"
  ([record](https://github.com/VeoveoAI/veoveo-docs/blob/main/records/2026-10-30-n8n-containment-spike.md)).
- Check: n8n starts against a schema that its login's group role owns, with no CREATE
  privilege on the database, and creates its tables there.

## Configuration, Not Changes

- **Table ownership:** n8n's PostgreSQL client (`pg` 8.21.0) reads `PGOPTIONS`, so
  `PGOPTIONS='-c role=server_<server>'` makes every connection take the server's group
  role, and n8n's tables belong to it instead of the per-registration login.
