"""Connections to the pipeline's Postgres. Each module connects as its own role."""

import os

import psycopg
from psycopg.rows import dict_row

# Port 54330 matches compose.yml. HCP_DATABASE_HOST lets a different setup point elsewhere.
HOST = os.environ.get("HCP_DATABASE_HOST", "localhost:54330")


def connect(role: str) -> psycopg.Connection:
    """Connect as one role. The grants in schema.sql decide what this connection can touch."""
    return psycopg.connect(f"postgresql://{role}@{HOST}/medinfo", row_factory=dict_row)
