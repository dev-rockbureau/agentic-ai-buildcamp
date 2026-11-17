"""The audit chain: one entry per step, linked to the entry before by hash.

The linking happens in the database, in audit.append(), so every module builds the chain the
same way. Entries can be added but never changed or removed. Payloads hold ids, versions and
outcomes, never a safety packet's words, because the graph's role can read this table.
"""

import psycopg
from psycopg.types.json import Jsonb

from medinfo.database import connect
from medinfo.policy import policy_version

APPEND = "select audit.append(%s, %s, %s)"


def record(connection: psycopg.Connection, question_id: str, entry_type: str, payload: dict):
    """Add an entry inside the caller's transaction, so it commits with the work it describes."""
    entry = {**payload, "policy": policy_version()}
    connection.execute(APPEND, (question_id, entry_type, Jsonb(entry)))


def record_alone(role: str, question_id: str, entry_type: str, payload: dict) -> None:
    """Add an entry in a transaction of its own, for a step that wrote nothing else."""
    with connect(role) as connection:
        record(connection, question_id, entry_type, payload)
