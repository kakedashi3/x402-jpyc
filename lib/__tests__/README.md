# `lib/__tests__`

Unit tests for `lib/payment-validation.ts`. The validation/simulation
logic is the security core of the facilitator — anything mistakenly
allowed here turns into a successful EIP-3009 transfer on Polygon.

## How to read these tests

- `payment-validation.test.ts` — one suite per public function
  (`validatePayment`, `simulateTransferWithAuthorization`, plus the
  helper exports `isValidNonceFormat` / `splitEip3009Signature`).
  Cases trace 1:1 to the catalog in `spec.md` "Error code catalog";
  the `code` field on each failed assertion is the contract.
- `fixtures/signer.ts` — deterministic test-only signers. Real EIP-712
  signatures are produced via viem's `privateKeyToAccount`, so the
  `verifyTypedData` path runs unmocked and a buggy signer/verifier
  pair would be caught. **Never reuse these keys outside tests.**
- `fixtures/mock-client.ts` — `PublicClient` test double with the
  five RPC methods pre-stubbed for the happy path. Each test overrides
  only the calls it cares about.

## Running

```bash
npm test                # all tests, no coverage
npm run test:coverage   # adds v8 coverage; payment-validation.ts goal: ≥90%
```

## Adding a case

1. Pick the error `code` (or the success branch) you want to pin down.
2. Build a body with `buildValidBody(...)` and mutate the one field
   that matters — keep mutations minimal so the failure is unambiguous.
3. Assert on `result.code` (and `result.status` when 4xx vs 5xx
   distinguishes user error from infra error). Avoid asserting on
   the human-readable `error` message — it is intentionally not part
   of the API contract.
