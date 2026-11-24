import type { createDb } from "@travelog/db";

/** Only called by the migration identity, never the API process. */
export async function provisionRuntimeRole(
  sql: ReturnType<typeof createDb>["sql"],
  rawUrl: string,
) {
  const url = new URL(rawUrl);
  const role = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (role !== "travelog_runtime" || password.length < 24)
    throw new Error("RUNTIME_DATABASE_URL 必須使用獨立的 travelog_runtime 帳號及至少 24 字元密碼");
  await sql.begin(async (tx) => {
    // Serialize concurrent deploy jobs. Identifiers/passwords are quoted by PostgreSQL format().
    await tx`SELECT pg_advisory_xact_lock(742091223)`;
    const [owner] = await tx`SELECT current_user AS name, current_database() AS database`;
    if (!owner || owner.name === role) throw new Error("migration 不可使用 runtime 身分");
    const [existing] = await tx`SELECT rolname FROM pg_roles WHERE rolname = ${role}`;
    if (!existing) await tx.unsafe(`CREATE ROLE travelog_runtime NOLOGIN`);
    const memberships = await tx`SELECT parent.rolname FROM pg_auth_members m
      JOIN pg_roles parent ON parent.oid = m.roleid
      JOIN pg_roles child ON child.oid = m.member WHERE child.rolname = ${role}`;
    for (const member of memberships) {
      const [command] =
        await tx`SELECT format('REVOKE %I FROM %I', ${member.rolname}, ${role}) AS statement`;
      await tx.unsafe(command!.statement);
    }
    const [alter] = await tx`SELECT format(
      'ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L',
      ${role}, ${password}) AS statement`;
    await tx.unsafe(alter!.statement);
    const [database] =
      await tx`SELECT format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC', ${owner.database}) AS statement`;
    await tx.unsafe(database!.statement);
    const [connect] =
      await tx`SELECT format('GRANT CONNECT ON DATABASE %I TO %I', ${owner.database}, ${role}) AS statement`;
    await tx.unsafe(connect!.statement);
    await tx`REVOKE CREATE ON SCHEMA public FROM PUBLIC`;
    await tx`REVOKE ALL ON SCHEMA public FROM travelog_runtime`;
    await tx`GRANT USAGE ON SCHEMA public TO travelog_runtime`;
    await tx`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM travelog_runtime`;
    await tx`REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM travelog_runtime`;
    // Grant only application-owned tables, excluding extension-owned relations.
    const tables =
      await tx`SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO travelog_runtime', n.nspname, c.relname) AS statement
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relowner = current_user::regrole
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`;
    for (const command of tables) await tx.unsafe(command.statement);
    await tx`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO travelog_runtime`;
    await tx`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO travelog_runtime`;
    await tx`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO travelog_runtime`;
    await tx`ALTER ROLE travelog_runtime SET search_path = public, pg_catalog`;
  });
}
