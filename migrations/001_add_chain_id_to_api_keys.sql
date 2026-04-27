-- 001_add_chain_id_to_api_keys.sql
--
-- Bind every api_key row to a specific EVM chain so the facilitator can
-- dispatch verify/settle to the right RPC and JPYC contract.
--
-- Existing rows default to 137 (Polygon mainnet) — the only chain the
-- facilitator served before this migration. New rows must be inserted
-- with the intended chain_id; the application validates it against
-- lib/chain-config.ts (currently 137 = Polygon, 80002 = Amoy).
--
-- Apply via the Supabase SQL editor or `psql $DATABASE_URL -f ...`.
-- Idempotent: re-runs are safe.

ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS chain_id INTEGER NOT NULL DEFAULT 137;

CREATE INDEX IF NOT EXISTS idx_api_keys_chain_id
  ON api_keys(chain_id);

-- Sanity check: refuse rows for chains the facilitator does not support.
-- Drop and re-create so the constraint is consistent across reapplies.
ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_chain_id_supported;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_chain_id_supported
  CHECK (chain_id IN (137, 80002));
