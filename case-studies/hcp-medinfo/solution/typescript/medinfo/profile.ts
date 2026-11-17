// The medical view of a requester: only what the Medical Question Helper may see about them.
import { type Client, firstRow } from "./database";

const MEDICAL_VIEW =
  "select id, kind, country, language, verified from shared.doctors where id = $1";

export type Requester = {
  id: string;
  kind: string;
  country: string | null;
  language: string;
  verified: boolean;
};

export async function medicalView(client: Client, requesterId: string): Promise<Requester> {
  const row = await firstRow<Requester>(client, MEDICAL_VIEW, [requesterId]);
  if (!row) throw new Error(`No doctor or rep with id ${requesterId}`);
  return row;
}
