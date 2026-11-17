// One place that knows how to reach the pipeline's Postgres, and as which role.
// Each module logs in as its own role, so the grants in schema.sql decide what it can touch.
import postgres from "pg";

export type DatabaseClient = postgres.Client;

export const ROLES = [
  "graph",
  "safety_scan",
  "gateway",
  "reviewer_cli",
  "steward_cli",
  "checker",
] as const;
export type Role = (typeof ROLES)[number] | "postgres";

// Port 54330 matches compose.yml. HCP_DATABASE_HOST lets a different setup point elsewhere.
const HOST = process.env.HCP_DATABASE_HOST ?? "localhost:54330";
const DATABASE_NAME = "medinfo";

// Postgres reports a missing grant with this code. The firewall check looks for it.
export const INSUFFICIENT_PRIVILEGE = "42501";
// A raise exception in a trigger, such as the audit table refusing a change.
export const RAISED_BY_TRIGGER = "P0001";

export function databaseUrl(role: Role): string {
  return `postgres://${role}@${HOST}/${DATABASE_NAME}`;
}

// Open a connection as one role, run the work, and always close the connection.
export async function withRole<Result>(
  role: Role,
  work: (client: DatabaseClient) => Promise<Result>,
): Promise<Result> {
  const client = new postgres.Client({ connectionString: databaseUrl(role) });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

// Run work inside a transaction that is always rolled back, so a check leaves no trace.
export async function inRolledBackTransaction<Result>(
  client: DatabaseClient,
  work: () => Promise<Result>,
): Promise<Result> {
  await client.query("begin");
  try {
    return await work();
  } finally {
    await client.query("rollback");
  }
}
