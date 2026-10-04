# Freshy Water 8.0 validation

Run `npm test` and `npm run build`.

- Existing real flush loop: 10 queued records, lost successful response, safe retry, no duplicate IDs, exact old settings baseline, PT409 conflict handling.
- UI workflows in a simulated DOM: debtor validation and continuation, Enter/Backspace behavior, village codes, unique employee controls, profile file picker, CSV exports, theme switching, QR print choice, demo-only reset preserving settings and 1,000 unmarked real-style records.
- Pagination: 1,000 customer groups produce 30 rendered cards per page; searching and export use the entire filtered dataset.
- Reports: 1,000 customer tables keep each customer's rows and subtotal together, including multiple debts for one customer, and preserve overall totals. QR choices are enabled by default.
- Server tests with mocked database and mail transport: opaque document tokens, authenticated document creation through the existing RPC when no service key is configured, rejection of anonymous and other-staff private document reads, preservation of customer table titles, legacy public documents, saved SMTP settings with TLS, normalized and deduplicated group recipients, admin-only paginated backups, recipient permissions, action toggles, report deduplication, Thai dates, white-paper PDF generation.
- Build produces updated standalone HTML and dist assets from the same sources; no production seed upload or database deletion is part of deployment.

These tests do not establish delivery to a real Gmail inbox or authenticated synchronization between two production devices. Those require the real account and server configuration. They are not a guarantee of zero defects.
