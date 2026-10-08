# Freshy Water 8.4 validation

Run `npm test` and `npm run build`.

- Payment workflow on isolated PostgreSQL: all members see every operational row; staff personnel/settings secrets stay private; migration preserves the complete data fingerprint; server stamps receiver/reviewer; staff receipt and approval request commit atomically; individual approval/rejection; mandatory cancellation reasons; receiver-only pending cancellation; approved-payment undo review; legacy receipts unchanged; anonymous and generic status-forging rejected.
- Receipt recovery uses the actual production client queue against PostgreSQL: response lost after commit, client restart, retry without a second receipt/request/audit entry; simultaneous receivers result in one success; a stale row rolls back an entire bulk operation.
- Staff/admin DOM history tests: staff immediately sees pending receipts and can cancel with a reason; admin history excludes pending receipts and includes them after approval; reviewer details appear; daily-report totals exclude pending amounts and expose a separate pending count/total.

- Existing real flush loop: 10 queued records, lost successful response, safe retry, no duplicate IDs, exact old settings baseline, PT409 conflict handling.
- UI workflows in a simulated DOM: debtor validation and continuation, Enter/Backspace behavior, village codes, unique employee controls, profile file picker, CSV exports, theme switching, QR print choice, demo-only reset preserving settings and 1,000 unmarked real-style records.
- Pagination: 1,000 customer groups produce 30 rendered cards per page; searching and export use the entire filtered dataset.
- Reports: 1,000 customer tables keep each customer's rows and subtotal together, including multiple debts for one customer, and preserve overall totals. QR choices are enabled by default.
- Server tests with mocked database and mail transport: opaque document tokens, authenticated document creation through the existing RPC when no service key is configured, rejection of anonymous and other-staff private document reads, preservation of customer table titles, legacy public documents, saved SMTP settings with TLS, normalized and deduplicated group recipients, admin-only paginated backups, recipient permissions, action toggles, report deduplication, Thai dates, white-paper PDF generation.
- Formal email tests verify an actual PDF attachment, normalized group recipients, server-authoritative business/author, and prevention of sending invalid reports. Simple alerts have no PDF. PDF samples and a 90-row, four-page report are rendered with Poppler for layout inspection. No real mail is sent.
- Saved-document DOM tests verify authenticated access, customer captions, merged total cells, signatures, QR rendering and printing without issuing a new document.
- Audit tests verify employee filtering (including former employees), pagination and access to records older than the latest 200.
- Build produces updated standalone HTML and dist assets from the same sources; no production seed upload or database deletion is part of deployment.

These tests do not establish delivery to a real Gmail inbox or authenticated synchronization between two production devices. Those require the real account and server configuration. They are not a guarantee of zero defects.
