"""What a reviewer's signature covers: the exact text, and the exact version of every cited source.

If either changes after signing, the hash no longer matches and the gateway refuses to send.
This is not a Part 11 electronic signature. It shows what a signature must cover.
"""

import hashlib

MEANING = "Approved for release: medical accuracy confirmed"


def source_key(doc_id: str, version: int, content_hash: str) -> str:
    return f"{doc_id}@{version}@{content_hash}"


def signature_hash(final_text: str, source_keys: list[str]) -> str:
    covered = final_text + "\n" + "\n".join(sorted(source_keys))
    return hashlib.sha256(covered.encode("utf-8")).hexdigest()


def draft_text(draft: list[dict]) -> str:
    """The draft as the doctor would read it: its sentences joined with spaces."""
    return " ".join(sentence["text"] for sentence in draft)


def pin_hash(reviewer_id: str, pin: str) -> str:
    return hashlib.sha256(f"hcp-medinfo:{reviewer_id}:{pin}".encode()).hexdigest()
