# SKAO-20 implementation verification

Implementation branch: `feature/SKAO-20-authentication`

Base: `5644d0d918f5e4ef84fe60ad091b70e6d4792c9a` (`development`, merged SKAO-19)

Handoff date: 2026-09-09

## Checks completed in the implementation workspace

| Check | Measured result |
|---|---|
| Server mock API regression suite | 66/66 passed before adding the final concurrency test |
| Final authentication suite | 17/17 passed, including the concurrent-disable test; 67 distinct mock tests verified across the full and focused runs |
| Client TypeScript and Vite production build | Passed |
| ESLint | Passed; one pre-existing hook-dependency warning in the unused MealsManagement page |
| Client React and transport tests | 31/31 passed |
| Embedded PostgreSQL full suite | 70 passed, 1 excluded; 15 suites passed |
| Embedded PostgreSQL updated authentication and reconnect persistence suites | 17/17 passed |
| Embedded PostgreSQL final concurrent-disable test | Blocked: timed out because the socket harness serializes connections during an open transaction; native verification remains required |
| Playwright discovery | All four browser scenarios discovered successfully |

The full embedded run preceded the added reconnect and concurrent-disable tests; the focused runs supplement it. These are not results from native PostgreSQL. The only exclusion in that earlier embedded full run was the existing test `recipe quantities stay numeric and invalid references cannot create orphan recipes`, due to the previously documented PGlite socket rollback limitation. It remains enabled in the repository and must pass on native PostgreSQL. The later concurrent-disable test passes with the mock adapter, but cannot be exercised faithfully by this single-transaction socket harness. Inspection of its QueryQueueManager confirmed that it queues every other connection while a transaction is open. No auth checks or tests are disabled in the normal application or native suites.

## Remaining release checks on Ubuntu / GitHub

1. Run the complete mock suite (67 tests) and complete native PostgreSQL suite (73 tests) with no exclusions.
2. Run all four Playwright scenarios in actual Chromium. This workspace could discover the tests but could not execute the browser binary.
3. Verify the existing PostgreSQL restart scenario in CI; it now signs in before direct API requests.
4. Back up the existing development database, apply migration 004, configure the Windows/VM frontend origin, and create the first administrator using the interactive command.
5. Verify normal sign-in, account administration and Meals in Windows Chrome. Use synthetic data until the private-pilot gate is complete.
6. Record the exact tested commit and native results, push the feature branch and open a PR to `development`. Merge after review and passing CI; then close SKAO-20 and its subtasks.

Implementation includes the source, migration, setup runbook and test updates. GitHub push, native/Chromium verification and merge are not claimed by this handoff.

## Ubuntu verification — September 9, 2026

The imported implementation was verified at `ef73bb0dda96875eed7ab95cf923d3d545f480ba`.
After the browser selector follow-up, the tested revision is recorded in the
follow-up commit.

| Check | Measured result |
|---|---|
| Server mock API suite | 67/67 passed |
| Native PostgreSQL suite | 73/73 passed across 16 suites; no exclusions |
| Client production build | Passed |
| ESLint | Passed with the existing `MealsManagement.tsx` hook-dependency warning |
| Client React/transport tests | 31/31 passed |
| Chromium browser suite | 4/4 passed, including sign-in, forced password change, read-only access, account disable/session revocation, catalog corrections and saved-week flows |

Before migration, the configured application database was backed up to a private
custom-format dump under `/tmp/SKAO-20-backup`. With the backend stopped,
`004-accounts-and-sessions` applied successfully. Existing database contents and
`.env` files were preserved; no accounts were created automatically, and no
reseed or database recreation was performed. `server/.env` now contains the
development origin `http://192.168.33.132:5173`, matching the existing client API
host `http://192.168.33.132:3001`.
