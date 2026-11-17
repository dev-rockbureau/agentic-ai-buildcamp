"""Connections to the pipeline's Postgres. Each module connects as its own role."""

import os
from collections.abc import Iterator
from contextlib import contextmanager

import psycopg
from langgraph.checkpoint.postgres import PostgresSaver
from psycopg.rows import dict_row

# Port 54330 matches compose.yml. HCP_DATABASE_HOST lets a different setup point elsewhere.
HOST = os.environ.get("HCP_DATABASE_HOST", "localhost:54330")


def url(role: str) -> str:
    return f"postgresql://{role}@{HOST}/medinfo"


def connect(role: str) -> psycopg.Connection:
    """Connect as one role. The grants in schema.sql decide what this connection can touch."""
    return psycopg.connect(url(role), row_factory=dict_row)


@contextmanager
def checkpointer() -> Iterator[PostgresSaver]:
    """The graph's checkpoints, kept in the langgraph schema as the graph role.

    A paused question lives here, so any later process can resume it on the same thread_id.
    """
    with psycopg.connect(
        url("graph"),
        autocommit=True,
        prepare_threshold=0,
        row_factory=dict_row,
        options="-c search_path=langgraph",
    ) as connection:
        saver = PostgresSaver(connection)
        saver.setup()
        yield saver
