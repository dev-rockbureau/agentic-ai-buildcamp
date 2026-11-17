"""The medical view of a requester: only what the Medical Question Helper may see about them."""

from dataclasses import dataclass

import psycopg

MEDICAL_VIEW = "select id, kind, country, language, verified from shared.doctors where id = %s"


@dataclass(frozen=True)
class Requester:
    id: str
    kind: str
    country: str | None
    language: str
    verified: bool


def medical_view(connection: psycopg.Connection, requester_id: str) -> Requester:
    row = connection.execute(MEDICAL_VIEW, (requester_id,)).fetchone()
    if row is None:
        raise LookupError(f"No doctor or rep with id {requester_id}")
    return Requester(**row)
