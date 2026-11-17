// The audit chain: one entry per step, linked to the entry before by hash.
// The linking happens in the database, in audit.append(), so every module builds the chain the
// same way. Entries can be added but never changed or removed. Payloads hold ids, versions and
// outcomes, never a safety packet's words, because the graph's role can read this table.
import { type Client, inTransaction } from "./database";
import { policyVersion } from "./policy";

const APPEND = "select audit.append($1, $2, $3::jsonb)";

// Add an entry inside the caller's transaction, so it commits with the work it describes.
export async function record(
  client: Client,
  questionId: string,
  entryType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const entry = { ...payload, policy: policyVersion() };
  await client.query(APPEND, [questionId, entryType, JSON.stringify(entry)]);
}

// Add an entry in a transaction of its own, for a step that wrote nothing else.
export async function recordAlone(
  role: string,
  questionId: string,
  entryType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await inTransaction(role, (client) => record(client, questionId, entryType, payload));
}
