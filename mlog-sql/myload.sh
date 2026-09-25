#!/bin/sh
# Load mlog.jsonl into a fresh t.db. Runs from any directory.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

rm -f "$here/t.db"
duckdb "$here/t.db" \
    -f "$here/schema.sql" \
    -c "set variable src='$here/mlog.jsonl';" \
    -f "$here/load.sql" \
    -c "select count(*) from object"
