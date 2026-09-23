# Financial write safety

Transfer, savings, loan, and ride-payment write endpoints are disabled by
default by `middleware/financialWriteGuard.js`.

The authenticated `/api/wallet/cash-in` and `/api/wallet/cash-out` flows are
enabled separately because they now use unique idempotency keys, pending ledger
records, MongoDB transactions, held funds for withdrawals, signed Paypack
webhooks, and exact event kind/amount matching. The Paypack webhook is not
behind the write gate because it must settle existing pending operations.

Required production settings for these wallet flows:

```env
PAYPACK_CLIENT_ID=...
PAYPACK_CLIENT_SECRET=...
PAYPACK_WEBHOOK_SECRET=...
PAYPACK_ENV=production
PAYPACK_CASHOUT_MINIMUM=10000
```

`PAYPACK_WEBHOOK_SECRET` must match the secret configured in the Paypack
dashboard. A missing secret rejects callbacks in production. Only local
development may explicitly set `PAYPACK_WEBHOOK_VERIFY=false`.

When Paypack enforces a 10,000 RWF cash-out minimum, smaller requests retain
their exact individual amount and fee in the ledger and are held in a per-user
queue. Paypack is called only when that same user's queued requested amounts
reach the configured minimum. Funds are restored if initiation or settlement
fails; users are never debited 10,000 RWF for a 2,000 RWF request.

Do not set `FINANCIAL_WRITES_ENABLED=true` in production until all remaining
guarded services have been migrated to a MongoDB replica set transaction that includes:

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
