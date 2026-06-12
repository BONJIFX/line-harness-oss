# CSA Pending Tasks

## LINE existing-friend recovery broadcast

- Status: blocked
- Blocker: LINE official account monthly message limit reached.
- Evidence: LINE Broadcast API returned `429 Too Many Requests` with `You have reached your monthly limit.` on 2026-06-12.
- Draft to send after limit recovery: `dc34873e-2e2b-45ce-9913-8c759ffaa465`
- Command after limit recovery:
  `pnpm run line:csa-interest-recovery -- --send-id=dc34873e-2e2b-45ce-9913-8c759ffaa465 --confirm-send=CSA_INTEREST_RECOVERY`
- Not blocking: new purchaser flow, admin approval flow, Discord invite issuance, and member-site login validation.
- Resume condition: LINE monthly sending limit is increased or reset.

