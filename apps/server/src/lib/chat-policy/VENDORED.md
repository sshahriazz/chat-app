# Vendored — do not edit here

The canonical copy is `app.onesuite.io/services/chat/policy/`.

All three repos have to agree about who can do what, and none of them can
import from the others. Vendoring is the compromise; the checksum test beside
this file is what stops the copies drifting, which is exactly how the three
components that answered "who can add whom" ended up disagreeing.

To change the rules:

1. Edit the canonical copy.
2. Update `POLICY_CHECKSUM` in its `checksum.test.ts`.
3. Re-run `scripts/vendor-chat-policy.sh` from the app repo.
4. Commit all three repos together.

A red checksum test here means this copy is stale, never that the canonical
one is wrong.
