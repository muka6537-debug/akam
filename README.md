# AUST ODL — Admissions & LMS Platform

Admissions portal, learning management system and centralized fee module for
the Open & Distance Learning programmes of Abbottabad University of Science &
Technology.

| App | Path | Port | Stack |
|---|---|---|---|
| Backend API | `backend/` | 5000 | Node 20+, Express, Prisma (SQLite) |
| Admissions portal | `frontend/` | 3000 | React + Vite |
| LMS | `lms-frontend/` | 3001 | React 19 + Vite + Tailwind |

All three apps share one backend and one database.

---

## Setup

```bash
cd backend      && npm install
cd ../frontend  && npm install
cd ../lms-frontend && npm install
```

Create `backend/.env` (see [Environment variables](#environment-variables)), then
build the database and load demo data:

The seed scripts and the e2e test do not read `.env` themselves, so export it
into the shell first (run this once per terminal, from `backend/`):

```bash
cd backend
set -a && . ./.env && set +a   # export DATABASE_URL, LMS_DEMO_FINANCE_PASSWORD, ...
npx prisma db push          # create / update the SQLite schema
npx prisma generate
node prisma/seed.js                 # admissions users, departments, programs, cycle
node prisma/seedLmsAcademic.js      # LMS programme, term, courses, offerings, students
node prisma/seedLmsRoles.js         # teachers, coordinator, focal, exam, QEC, provost
node prisma/seedUniversityDataset.js   # optional: larger synthetic dataset
node prisma/seedProvostData.js         # optional: historical fee challans and fines
```

`npm run setup` runs `prisma db push` plus the base seed in one go.

## Running

Development, each app in its own terminal:

```bash
cd backend && npm start
cd frontend && npm run dev
cd lms-frontend && npm run dev -- --host 0.0.0.0 --port 3001
```

Or all three with PM2 from the repository root:

```bash
pm2 start ecosystem.config.cjs
pm2 logs --nostream
pm2 restart all
```

Production build of the frontends: `npm run build` in `frontend/` and
`lms-frontend/` (output in `dist/`). The LMS build needs about 2 GB of memory
(`NODE_OPTIONS=--max-old-space-size=3072`).

Health check: `GET http://localhost:5000/api/health`.

On boot the backend idempotently provisions the role demo accounts, mirrors the
Super Admin into the LMS login, installs the result-immutability triggers,
syncs live classes, seeds the fee module's default fee heads, payment methods
and concession types, and starts the fee scheduler (late fees, overdue status,
deadline reminders, concession condition checks every 15 minutes).

## Environment variables

`backend/.env`:

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | e.g. `file:./dev.db` |
| `JWT_SECRET` | yes | Signs admissions and LMS session tokens |
| `PORT` | no | API port, default `5000` |
| `FRONTEND_URL` | no | Admissions URL used in emails / CORS |
| `CAPTCHA_DISABLED` | no | `1` skips the login captcha (development) |
| `DISABLE_DEMO_SEED` | no | `1` stops the boot-time demo account provisioning (it never runs with `NODE_ENV=production`) |
| `LMS_DEMO_FINANCE_PASSWORD` | no | Password for the `finance_demo` account; the account is not created when unset. Local-dev default: `Finance@123` |
| `NODE_ENV` | no | `production` disables all demo account provisioning; `seedDemoAccounts.js` refuses to run |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | no | Outbound email; without them emails are logged only |
| `PAYMENT_GATEWAY_MODE` | no | `sandbox` (default), `live` or `manual` |
| `BANK_GATEWAY_NAME`, `BANK_GATEWAY_API_URL`, `BANK_GATEWAY_API_KEY`, `BANK_GATEWAY_SECRET_KEY`, `BANK_GATEWAY_MERCHANT_ID`, `BANK_GATEWAY_CALLBACK_URL`, `BANK_GATEWAY_WEBHOOK_SECRET`, `BANK_GATEWAY_RETURN_URL` | no | Bank payment gateway credentials; values saved by the Super Admin under *System → Payment Gateway* override these |
| `BBB_URL`, `BBB_SECRET` | no | BigBlueButton API root and shared secret for live classes; without them live classes fall back to external links |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `AI_MODEL`, `GSK_TOKEN` | no | OpenAI-compatible endpoint for the AI tutor and question generation |
| `LMS_WATCH_ATTENDANCE_THRESHOLD` | no | % of a recorded lecture that counts as attendance (default 70) |
| `LMS_TZ_OFFSET_MINUTES` | no | Timezone offset for schedules (default +300, PKT) |
| `LMS_SLA_URGENT_HOURS`, `LMS_SLA_HIGH_HOURS`, `LMS_SLA_MEDIUM_HOURS`, `LMS_SLA_LOW_HOURS` | no | Grievance SLA targets |

Frontends (optional, `frontend/.env` / `lms-frontend/.env`):

| Variable | Purpose |
|---|---|
| `VITE_API_URL` | API base, default `/api` (Vite proxies to port 5000) |
| `VITE_LMS_URL` | LMS URL linked from the admissions portal |
| `VITE_ADMISSIONS_URL` | Admissions URL used for the Super Admin hand-off from the LMS login |

When opened through a sandbox preview host (`3000-…`, `3001-…`) both frontends
detect the host and call the backend on the matching `5000-…` host directly.

## Migrations

The working database is SQLite and is kept in sync with `prisma db push`.
`backend/prisma/migrations/` holds the same changes as SQL so the schema can be
promoted to a migrated database:

```bash
npx prisma migrate deploy        # apply on a migrated database
npx prisma migrate diff --from-schema-datamodel <old.prisma> \
  --to-schema-datamodel prisma/schema.prisma --script   # draft a new migration
```

`20261004000000_centralized_fee_module` adds the fee module tables, extends
`LmsFeeChallan` with gross / concession / late-fee / paid columns (back-filling
existing challans) and drops the old scope-based `LmsFeeAnnouncement`.

## Demo accounts

Admissions portal (port 3000):

| Role | Login | Password |
|---|---|---|
| Super Admin | `superadmin` | `superadmin123` |
| Director Admissions | `director` | `director123` |
| Department Coordinator | `coordinator` | `coord123` |
| Applicant | `student` | `student123` |

LMS (port 3001). Username or email both work:

| Role | Login | Password |
|---|---|---|
| Student | `ADCS-001` … `ADCS-012`, `student_demo` | `Lms@1234` / `Student@123` |
| Teacher | `teacher1`, `teacher_demo` | `Lms@1234` / `Teacher@123` |
| Course Coordinator | `coord1`, `coordinator_demo` | `Lms@1234` / `Coordinator@123` |
| Focal Person | `focal1`, `focal_demo` | `Lms@1234` / `Focal@123` |
| Exam Controller | `exam1`, `examcontroller_demo` | `Lms@1234` / `Exam@123` |
| Director QEC | `qec1`, `qec_demo` | `Lms@1234` / `QEC@123` |
| Provost | `provost1`, `provost_demo` | `Lms@1234` / `Provost@123` |
| Finance | `finance_demo` | value of `LMS_DEMO_FINANCE_PASSWORD` |

The Super Admin's admissions credentials also sign in through the LMS login and
are handed off to the Super Admin console.

---

## Architecture

```
backend/src
  server.js              Express app, route mounting, boot-time initialisers
  middleware/            auth (admissions JWT), lmsAuth (LMS JWT), uploads, validation
  routes/                admissions API (auth, applications, merit, fee, admission-cycle, …)
  routes/lms/            LMS auth + academic routers (student, teacher, coordinator,
                         focal, exam, qec, provost, fees, grievances, marks workflow)
  modules/super-admin/   Super Admin console API
  services/              domain logic (academic, results, gradebook, fee module, exports)
  utils/                 prisma client, audit, notifications, realtime (SSE), helpers
backend/prisma           schema.prisma, migrations, seed scripts
backend/scripts/qa       end-to-end checks against a running backend
```

- **Admissions** (`/api/auth`, `/api/applications`, `/api/admission-cycle`,
  `/api/merit`, `/api/fee`, `/api/fee-management`, `/api/enrollment`, …): applicant
  profile and documents, unified admission-cycle announcement with per-program
  merit criteria and fee breakdown, initial / final merit lists, interviews and
  appeals, processing and admission fee payments, roll / registration numbers and
  LMS credential issuance.
- **LMS** (`/api/lms/*`): LmsUser-based auth with eight roles (Student, Teacher,
  CourseCoordinator, FocalPerson, ExamController, QECCoordinator, Provost, Finance)
  plus SuperAdmin. Scheme of study, auto-enrolment, live and recorded classes,
  assignments, quizzes, lab tasks, attendance, PIN-gated marks entry and results
  submission, exam controller result workflow and gazette, transcripts, surveys,
  grievances, department-isolated focal person oversight.
- **Super Admin** (`/api/super-admin/*`): institution, users, academic config,
  LMS oversight and governance, system configuration, reports and overrides.

Every LMS write goes through `utils/lmsAudit.js` (actor, action, before/after)
and notifications through `utils/lmsNotify.js`.

## Centralized Fee Module

Backend: `services/feeStructure.js`, `feeBilling.js`, `feeConcessions.js`,
`feeHolds.js`, `feeStudents.js`, `feeExports.js`; routes in
`routes/lms/academic/fees.js` (`/api/lms/academic/fees/*`) and
`routes/feeStructures.js` (`/api/fee-structures/*`, Director Admissions).
LMS pages live in `lms-frontend/src/pages/fees/` and are shared across roles.

### Fee structure sync (Admissions → Fee Module)

- Announcing a cycle (`POST /api/admission-cycle/announce`) emits an
  `admission:announced` event; it is the only touchpoint with the Admission
  System. The fee module maps each program's fee breakdown onto fee heads and
  stores a **Program + Batch** structure (e.g. `ADCS – Fall 2026`).
- Fee heads are configurable: **One-time** (first semester only), the
  **Semester Fee** (recurring, locked), **Other** heads with independent
  one-time/recurring and locked/revisable flags, and **Charges**. Labels like
  "Tuition Fee" map to the Semester Fee; unknown labels become one-time Other heads.
- The semester fee is **snapshotted** on the first sync of a batch and never
  changes, even when a later cycle announces a different fee. Re-syncs only
  update revisable heads. The Director can re-sync from `/api/fee-structures/sync/:cycleId`.
- Only a Provost concession changes what an individual student pays; every
  sync, re-sync and revision is audit-logged.

### Existing Provost fee pages

The Provost's original fee pages are unchanged and sit alongside the module:
Fee Management, Announce Fees (`LmsFeeAnnouncement`, scoped by
university/department/program/semester), Student Fee Records with
block/unblock, Fee Reports (CSV/printable), Fee and Exam Fee Announcements, Fee
Approvals and Defaulters (`/api/lms/academic/provost/*`). Challans they create
use the same `LmsFeeChallan` table, so they show up in the module's reports and
holds, and approvals are recorded as payments. The module's own status reports
are at `/provost/fee-status-reports`.

### Provost fee notifications

The Provost picks programs, batches, semesters, extra fee heads and amounts, a
last date and an optional late fee (flat or per day). Generation is automatic:
each targeted student gets an individual challan made of their batch's semester
dues (locked semester fee, one-time heads in semester 1, recurring heads), the
announced heads, less their concessions, and is notified. Students without a
synced structure are listed as skipped; *Regenerate* picks them up later. Each
notification shows live progress (paid / partial / unpaid / overdue, amount
collected).

### Payments

Payment methods are configurable (`LmsPaymentMethod`). *Instant* methods
(online gateway, wallet) confirm at checkout from the student's Fee Account;
*manual* methods (bank deposit, over-the-counter challan) are confirmed by
Finance with the bank reference, or by a gateway settlement. All channels use
the same confirmation path, support partial payments, reject reused
references, update the challan immediately, notify the student and write an
audit entry.

### Concessions

The Provost searches by Reg No, roll no, name, CNIC, program or batch and
applies a concession of a configurable type (waiver, reduction, scholarship …)
as a percentage or flat amount on selected fee heads, with a mandatory reason,
a proof document, a duration (N semesters or until the last semester) and an
optional minimum-CGPA condition. It applies to the student's next challans for
its duration. Concessions whose condition is no longer met move to **Needs
Review** and stop applying until the Provost reinstates or revokes them;
nothing is revoked automatically. Apply / revise / revoke / flag / expire
actions form a per-concession audit trail. Lists: Waived, Reduced, Scholarship
Holders, Expiring Soon, Needs Review, Revoked.

### Dues holds (LMS integration)

A student with an overdue challan is blocked from course registration
(auto-enrolment and coordinator-approved requests), admit-card generation
(`/student/admit-card`), and promotion confirmation (focal promotions show
**Hold**; Super Admin promotion is refused). Holds are derived from challan
state, so they lift as soon as the dues are paid.

### Charges

- Frozen / vacant semester: 25% of the batch's locked semester fee (Finance).
- Resit: Rs. 2,000 per course (Finance or Course Coordinator).
- Special semester: amount set by the Course Coordinator.
- Late registration: Rs. 1,500 by default (Finance or Course Coordinator).
- Absence appeal: Rs. 1,000, raised automatically when a student files a grievance
  in the *Absence Appeal* category.

### Reports and exports

Paid / Unpaid / Partial / Overdue reports, concession lists and the fee
defaulter list, all filterable by program, batch and semester and exportable to
Excel and PDF. Challans and admit cards download as PDF.

### Roles

| Role | Fee module access |
|---|---|
| Director Admissions | Cycle announcement triggers the sync; view / re-sync structures |
| Provost | Notifications, concessions and concession types; reports, defaulters, audit |
| Finance | Payment confirmation, charges, fee heads, revisable amounts, payment methods; reports, defaulters, audit |
| Focal Person | Reports and defaulter list |
| Course Coordinator | Special-semester fee, resit and late-registration charges |
| Student | Own Fee Account (total due, paid, remaining, deadline, concessions, payment history), online payment, admit card |

### Notifications sent to students

New challan, payment confirmation (full or partial), concession applied /
revised / removed, deadline reminder three days before the due date, overdue
notice with the late fee. Provosts are notified when a concession needs review.

### End-to-end check

With the backend running on a development database:

```bash
cd backend
set -a && . ./.env && set +a   # needs DATABASE_URL and LMS_DEMO_FINANCE_PASSWORD
node scripts/qa/feeModuleE2E.js
```

It announces a cycle, verifies the locked snapshot and re-sync behaviour,
announces notifications, pays through the student and Finance channels,
applies and revises a concession, verifies the holds and their release, raises
every charge type and downloads every export.

---

## Integrations

### Bank payment gateway

Processing and admission fees use a generic bank gateway abstraction
(`utils/bankGateway.js`): `POST /api/payments/gateway/processing-fee`,
`POST /api/payments/gateway/admission-fee`, callback
`/api/payments/gateway/callback`. In `sandbox` mode payments are recorded
instantly; `live` calls the bank with HMAC-SHA256 signed requests and verifies
webhooks with `BANK_GATEWAY_WEBHOOK_SECRET`; `manual` disables the online
method. Going live only requires the credentials above.

### BigBlueButton

Live classes create meetings on a university-hosted BigBlueButton server when
`BBB_URL` (API root, no trailing slash) and `BBB_SECRET` (from
`bbb-conf --secret`) are set. Teachers join as moderators, students as
attendees; join/leave events feed live-class attendance and recordings are
listed per class. Without these variables, coordinators can schedule classes
with an external meeting link.
