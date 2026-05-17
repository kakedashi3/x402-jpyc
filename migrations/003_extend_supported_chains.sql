-- 003_extend_supported_chains.sql
--
-- Widen the api_keys.chain_id CHECK constraint to admit the three new EVM
-- mainnets that JPYC has launched on (Ethereum, Avalanche, Kaia) in
-- addition to the existing Polygon mainnet (137) and Amoy testnet (80002).
--
-- JPYC shares the proxy address 0xe7c3d8c9a439fede00d2600032d5db0be71c3c29
-- across all four mainnets, all at 18 decimals, with the EIP-712 domain
-- name="JPY Coin", version="1". See lib/chain-config.ts for the
-- application-side registry.
--
-- Note: code support does NOT imply mainnet liquidity. The facilitator
-- wallet still needs native gas (ETH / AVAX / KAIA) on each new mainnet
-- before /settle can succeed end-to-end there. /verify and /settle will
-- correctly route to the right RPC the moment a row is inserted with
-- the matching chain_id.
--
-- Apply via the Supabase SQL editor or `psql $DATABASE_URL -f ...`.
-- Idempotent: drop-and-recreate the constraint so re-runs are safe.

ALTER TABLE api_keys
  DROP CONSTRAINT IF EXISTS api_keys_chain_id_supported;

ALTER TABLE api_keys
  ADD CONSTRAINT api_keys_chain_id_supported
  CHECK (chain_id IN (1, 137, 80002, 43114, 8217));
