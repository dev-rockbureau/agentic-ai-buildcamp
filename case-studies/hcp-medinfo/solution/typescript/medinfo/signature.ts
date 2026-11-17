// What a reviewer's signature covers: the exact text, and the exact version of every cited source.
// If either changes after signing, the hash no longer matches and the gateway refuses to send.
// This is not a Part 11 electronic signature. It shows what a signature must cover.
import { createHash } from "node:crypto";

export const MEANING = "Approved for release: medical accuracy confirmed";

export type Sentence = { text: string; cites: string[] };

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export const sourceKey = (docId: string, version: number, contentHash: string) =>
  `${docId}@${version}@${contentHash}`;

export function signatureHash(finalText: string, sourceKeys: string[]): string {
  return sha256(`${finalText}\n${[...sourceKeys].sort().join("\n")}`);
}

// The draft as the doctor would read it: its sentences joined with spaces.
export const draftText = (draft: Sentence[]) => draft.map((sentence) => sentence.text).join(" ");

export const pinHash = (reviewerId: string, pin: string) =>
  sha256(`hcp-medinfo:${reviewerId}:${pin}`);
