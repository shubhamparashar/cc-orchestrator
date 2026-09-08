tags: redis, lambda, graphql
## Goal
Fix intermittent Redis failures in the GraphQL Lambda.
## Key files
- packages/functions/src/utils/redis.ts: singleton client, checkClientInitialised
## Decisions
- Keep the process-wide singleton; do not open a client per invocation.
## State
- ~1,272 errors over 7 days when the socket is in `end` state (open)
- Products saved without shipping rates as a result (open)
## Next step
- Make checkClientInitialised status-aware and recover from `end` state
