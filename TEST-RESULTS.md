# Freshy Water 8.0 validation

Run `npm test` and `npm run build`.

- Existing real flush loop: 10 queued records, lost successful response, safe retry, no duplicate IDs, exact old settings baseline, PT409 conflict handling.
- UI workflows in a simulated DOM: debtor validation and continuation, Enter/Backspace behavior, village codes, unique employee controls, profile file picker, CSV exports, theme switching, QR print choice, demo-only reset preserving settings and 1,000 unmarked real-style records.
- Pagination: 1,000 customer groups produce 30 rendered cards per page; searching and export use the entire filtered dataset.
- Server tests with mocked database and mail transport: opaque document tokens, immutable snapshot storage, anonymous exact-document read, admin-only paginated backups, fixed Gmail TLS endpoint, recipient permissions, action toggles, report deduplication, Thai dates, white-paper PDF generation.
- Build produces updated standalone HTML and dist assets from the same sources; no production seed upload or database deletion is part of deployment.

These tests do not establish delivery to a real Gmail inbox or authenticated synchronization between two production devices. Those require the real account and server configuration. They are not a guarantee of zero defects.
