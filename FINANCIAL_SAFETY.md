# Financial write safety

Balance-changing wallet, transfer, savings, loan, and payment endpoints are
disabled by default by `middleware/financialWriteGuard.js`.

Do not set `FINANCIAL_WRITES_ENABLED=true` in production until all affected
services have been migrated to a MongoDB replica set transaction that includes:

1. An idempotency record with a unique `(userId, operation, key)` index.
2. Conditional balance debits that cannot take a wallet below zero.
3. The corresponding credit/debit ledger entries.
4. The domain record (transfer, repayment, savings movement, or provider event).
5. A committed response snapshot returned for safe retries.

External payment-provider calls cannot be part of a MongoDB transaction. Use an
outbox/state-machine flow: commit a pending intent first, call the provider with
the intent's stable reference, then apply a verified callback exactly once.

MongoDB transactions require a replica set. Tests must cover simultaneous
requests, duplicate idempotency keys, transaction rollback, delayed callbacks,
duplicate callbacks, and provider timeouts before this gate is enabled.
