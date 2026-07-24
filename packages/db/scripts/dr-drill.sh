#!/usr/bin/env bash
# ProcureFlow disaster-recovery restore drill (Slice 11c).
#
# Runs a REAL backup -> restore-to-fresh-database -> smoke-test cycle against the
# local Docker Postgres and measures actual wall-clock time-to-restore. This is
# the honest local proxy for the prod RDS restore path — it exercises the same
# pg_dump/pg_restore mechanics and the same schema, at local data scale. It does
# NOT prove the production RTO on RDS Multi-AZ; see docs/operations/dr-drill-*.md
# for what this does and does not establish.
#
# Usage: bash packages/db/scripts/dr-drill.sh
# Requires: the docker-compose stack up (procureflow-postgres healthy).
set -euo pipefail

CONTAINER="${PG_CONTAINER:-procureflow-postgres}"
PGUSER="${POSTGRES_USER:-procureflow}"
PGPW="${POSTGRES_PASSWORD:-procureflow_dev_pw}"
SRC_DB="${POSTGRES_DB:-procureflow}"
DR_DB="${DR_DB:-procureflow_dr}"
DUMP="/tmp/dr_backup.dump"

dexec() { docker exec -e PGPASSWORD="$PGPW" "$CONTAINER" "$@"; }

echo "== ProcureFlow DR drill =="
echo "source=$SRC_DB  target=$DR_DB  container=$CONTAINER"

echo "-- 1. Backup (pg_dump -Fc) --"
b0=$(dexec date +%s.%N)
dexec pg_dump -U "$PGUSER" -d "$SRC_DB" -Fc -f "$DUMP"
b1=$(dexec date +%s.%N)
echo "   backup_seconds=$(echo "$b1 - $b0" | bc)  size=$(dexec sh -c "ls -lh $DUMP | awk '{print \$5}'")"

echo "-- 2. Restore to fresh $DR_DB --"
dexec dropdb -U "$PGUSER" --if-exists "$DR_DB"
dexec createdb -U "$PGUSER" "$DR_DB"
r0=$(dexec date +%s.%N)
dexec pg_restore -U "$PGUSER" -d "$DR_DB" --no-owner --jobs=4 "$DUMP" 2>/tmp/restore.log || true
r1=$(dexec date +%s.%N)
echo "   restore_seconds=$(echo "$r1 - $r0" | bc)  restore_errors=$(dexec sh -c 'grep -icE error /tmp/restore.log')"

echo "-- 3. Smoke test: row parity source vs restored --"
for tbl in Invoice PurchaseOrder Vendor AuditLog Tenant; do
  s=$(dexec psql -U "$PGUSER" -d "$SRC_DB" -tA -c "SELECT count(*) FROM \"$tbl\";")
  d=$(dexec psql -U "$PGUSER" -d "$DR_DB"  -tA -c "SELECT count(*) FROM \"$tbl\";")
  flag="OK"; [ "$s" != "$d" ] && flag="** MISMATCH **"
  printf "   %-16s source=%-7s restored=%-7s %s\n" "$tbl" "$s" "$d" "$flag"
done

echo "-- 4. Integrity: audit hash-chain verify on the RESTORED db --"
echo "   run: DIRECT_DATABASE_URL=postgresql://$PGUSER:***@127.0.0.1:5432/$DR_DB \\"
echo "        pnpm --filter @procureflow/db exec tsx scripts/verify-audit-chain.ts"
echo "== drill complete — record measured numbers in docs/operations/dr-drill-<date>.md =="
