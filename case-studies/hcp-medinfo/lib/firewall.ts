// The firewall rule: each role can do what its job needs and nothing it must never do.
// Every attempt runs in a transaction that is rolled back, so the check changes nothing.
import {
  type DatabaseClient,
  INSUFFICIENT_PRIVILEGE,
  inRolledBackTransaction,
  RAISED_BY_TRIGGER,
  type Role,
  withRole,
} from "./database";

export type Line = { says: string; result: "pass" | "fail"; detail?: string };

type Attempt = {
  says: string;
  role: Role;
  sql: string;
  // "allowed" passes when the statement works. An error code passes when Postgres refuses with it.
  expect: "allowed" | typeof INSUFFICIENT_PRIVILEGE | typeof RAISED_BY_TRIGGER;
};

const SEND_ONE = `insert into outbox.messages (id, question_id, kind, recipient_id, text)
  values ('M-FIREWALL', 'Q-001', 'reply', 'D-US-01', 'firewall check')`;
const ADD_AUDIT_ENTRY = `insert into audit.entries
  (question_id, seq, type, payload, prev_hash, hash)
  values ('Q-FIREWALL', 1, 'firewall_check', '{}', 'start', 'firewall')`;
const CHANGE_AUDIT_ENTRY = `${ADD_AUDIT_ENTRY};
  update audit.entries set type = 'changed' where question_id = 'Q-FIREWALL'`;
const DELETE_AUDIT_ENTRY = `${ADD_AUDIT_ENTRY};
  delete from audit.entries where question_id = 'Q-FIREWALL'`;

const ATTEMPTS: Attempt[] = [
  {
    says: "graph can't read safety packets",
    role: "graph",
    sql: "select 1 from safety.packets limit 1",
    expect: INSUFFICIENT_PRIVILEGE,
  },
  {
    says: "graph can't write to the outbox",
    role: "graph",
    sql: SEND_ONE,
    expect: INSUFFICIENT_PRIVILEGE,
  },
  {
    says: "reviewer_cli can't write to the outbox",
    role: "reviewer_cli",
    sql: SEND_ONE,
    expect: INSUFFICIENT_PRIVILEGE,
  },
  {
    says: "safety_scan can't read the approved library",
    role: "safety_scan",
    sql: "select 1 from knowledge.documents limit 1",
    expect: INSUFFICIENT_PRIVILEGE,
  },
  {
    says: "gateway can write to the outbox",
    role: "gateway",
    sql: SEND_ONE,
    expect: "allowed",
  },
  {
    says: "graph can read the approved library",
    role: "graph",
    sql: "select 1 from knowledge.chunks limit 1",
    expect: "allowed",
  },
  {
    says: "checker can read safety packets",
    role: "checker",
    sql: "select 1 from safety.packets limit 1",
    expect: "allowed",
  },
  {
    says: "checker can't write anything",
    role: "checker",
    sql: SEND_ONE,
    expect: INSUFFICIENT_PRIVILEGE,
  },
  {
    says: "even the database owner can't change an audit entry",
    role: "postgres",
    sql: CHANGE_AUDIT_ENTRY,
    expect: RAISED_BY_TRIGGER,
  },
  {
    says: "even the database owner can't delete an audit entry",
    role: "postgres",
    sql: DELETE_AUDIT_ENTRY,
    expect: RAISED_BY_TRIGGER,
  },
];

// Run the statement and report the Postgres error code, or "allowed" when it worked.
async function outcomeOf(client: DatabaseClient, sql: string): Promise<string> {
  try {
    await inRolledBackTransaction(client, () => client.query(sql));
    return "allowed";
  } catch (error) {
    return (error as { code?: string }).code ?? "unknown error";
  }
}

async function tryAttempt(attempt: Attempt): Promise<Line> {
  const outcome = await withRole(attempt.role, (client) => outcomeOf(client, attempt.sql));
  if (outcome === attempt.expect) return { says: attempt.says, result: "pass" };
  const detail = `expected ${attempt.expect}, got ${outcome}`;
  return { says: attempt.says, result: "fail", detail };
}

export async function checkFirewall(): Promise<Line[]> {
  const lines: Line[] = [];
  for (const attempt of ATTEMPTS) lines.push(await tryAttempt(attempt));
  return lines;
}
