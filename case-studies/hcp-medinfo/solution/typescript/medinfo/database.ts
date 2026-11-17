// Connections to the pipeline's Postgres. Each module connects as its own role, so the grants in
// schema.sql decide what it can touch.
import pg from "pg";

// Port 54330 matches compose.yml. HCP_DATABASE_HOST lets a different setup point elsewhere.
const HOST = process.env.HCP_DATABASE_HOST ?? "localhost:54330";

export type Client = pg.Client;
export type Row = Record<string, unknown>;

export const url = (role: string) => `postgres://${role}@${HOST}/medinfo`;

// Postgres reports a serializable transaction that lost a race with this code.
export const SERIALIZATION_FAILURE = "40001";

// Run work as one role in one transaction: commit when it returns, roll back when it throws.
export async function inTransaction<Result>(
  role: string,
  work: (client: Client) => Promise<Result>,
  serializable = false,
): Promise<Result> {
  const client = new pg.Client({ connectionString: url(role) });
  await client.connect();
  try {
    await client.query(serializable ? "begin isolation level serializable" : "begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

export async function firstRow<Shape = Row>(
  client: Client,
  sql: string,
  values: unknown[] = [],
): Promise<Shape | undefined> {
  return (await client.query(sql, values)).rows[0] as Shape | undefined;
}
