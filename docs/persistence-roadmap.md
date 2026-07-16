# Persistence Roadmap

## Current step

The app now creates a versioned `PlanSnapshot` and can save it through `/api/plans/save`.
In development this writes JSON files to:

```text
.data/plans/{tenantId}/{siteId}/plan-{timestamp}.json
```

This is intentionally shaped like a future multi-tenant backend record instead of a browser-only localStorage dump.

## Production target

For subscriber accounts, the same snapshot should be saved behind authenticated API routes:

- `tenants`: subscriber/company account boundary
- `users`: login identities and roles
- `sites`: customer locations or UniFi sites
- `plans`: versioned rack/network plans per site
- `unifi_connections`: encrypted UniFi tokens scoped to tenant/site

Every read/write must include the authenticated `tenantId`, so one subscriber's plans cannot mix with another subscriber's data.

## Apple app target

The native Apple app should use the same authenticated API as the website. Local device storage can cache the latest plan for offline viewing/editing, but the server remains the source of truth.

Good next backend choices:

- Supabase/Postgres for fastest auth + database path
- Firebase for fast auth + realtime sync
- Custom Node/Express API + Postgres if we want maximum control

