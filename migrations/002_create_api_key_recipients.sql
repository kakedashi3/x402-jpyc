-- 002_create_api_key_recipients.sql
--
-- Introduce an allowlist of payTo addresses per API key. Replaces the
-- previous 1-key-to-1-payTo binding while keeping api_keys.recipient_address
-- intact as the "primary" so the facilitator can fall back to it when an
-- api_key has no recipients yet (preserves the old single-recipient model
-- for any row that somehow skips the backfill).
--
-- No chain_id column here: each recipient inherits its parent api_key's
-- chain. Scope decision documented in
-- knowledge/x402-jpyc-mameta-zk-case.md (2026-05-15) — Polygon-only for
-- the first cut, multichain deferred. When multichain returns, add a
-- chain_id column and widen the unique index.
--
-- Apply via the Supabase SQL editor or `psql $DATABASE_URL -f ...`.
-- Idempotent: re-runs are safe.

CREATE TABLE IF NOT EXISTS public.api_key_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  api_key_id UUID NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  recipient_address TEXT NOT NULL,
  label TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- EVM address format check, matching api_keys.recipient_address (#16).
ALTER TABLE public.api_key_recipients
  DROP CONSTRAINT IF EXISTS api_key_recipients_address_check;
ALTER TABLE public.api_key_recipients
  ADD CONSTRAINT api_key_recipients_address_check
  CHECK (recipient_address ~ '^0x[0-9a-fA-F]{40}$');

-- One row per (api_key, address). Case-insensitive to dodge EIP-55
-- checksum quirks (same recipient, different capitalisation, must not
-- be allowed to register twice).
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_key_recipients_unique
  ON public.api_key_recipients(api_key_id, lower(recipient_address));

-- Fast active-recipient lookup during verify/settle (allowlist check).
CREATE INDEX IF NOT EXISTS idx_api_key_recipients_active
  ON public.api_key_recipients(api_key_id) WHERE is_active;

-- Backfill: every existing api_keys row gets a 'primary' recipient
-- mirroring its current recipient_address. is_active follows the
-- parent so an inactive api_key does not surface an active allowlist
-- entry. ON CONFLICT keeps the migration safe to re-run.
INSERT INTO public.api_key_recipients (api_key_id, recipient_address, label, is_active)
SELECT id, recipient_address, 'primary', is_active
FROM public.api_keys
ON CONFLICT DO NOTHING;

-- RLS: mirror api_keys security model.
ALTER TABLE public.api_key_recipients ENABLE ROW LEVEL SECURITY;

-- Owners (authenticated users) can read recipients for their own api_keys.
DROP POLICY IF EXISTS "Users can view their own api_key_recipients"
  ON public.api_key_recipients;
CREATE POLICY "Users can view their own api_key_recipients"
  ON public.api_key_recipients FOR SELECT
  USING (api_key_id IN (SELECT id FROM public.api_keys WHERE user_id = auth.uid()));

-- Owners can update recipients for their own api_keys (e.g. flip is_active,
-- rename label).
DROP POLICY IF EXISTS "Users can update their own api_key_recipients"
  ON public.api_key_recipients;
CREATE POLICY "Users can update their own api_key_recipients"
  ON public.api_key_recipients FOR UPDATE
  USING (api_key_id IN (SELECT id FROM public.api_keys WHERE user_id = auth.uid()));

-- INSERT only via service_role (matches api_keys policy #15). Server
-- actions in the dashboard use SUPABASE_SERVICE_ROLE_KEY for both
-- inserts and bulk imports.
DROP POLICY IF EXISTS "Deny insert for non-service roles"
  ON public.api_key_recipients;
CREATE POLICY "Deny insert for non-service roles"
  ON public.api_key_recipients FOR INSERT
  WITH CHECK (false);

-- DELETE has no authenticated policy, so it is denied by default — only
-- service_role can delete. Matches api_keys.
