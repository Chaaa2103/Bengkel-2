# Smart Sports Facility Booking System: Progress II prototype

UTeM sports court booking with automatic lighting (AWS IoT Core + ESP32), Telegram alerts, reports and an AWS cloud design.
Group 11, BITU 3923 Workshop II.

## What is in this project

| Folder or file | What it is |
|---|---|
| `server.js`, `src/` | Node.js (Express) back end: login, RBAC, CRUDS, complex queries, reports, IoT gateway, scheduler |
| `db/schema.sql` | MySQL 8 schema, 11 tables, same as your Progress I data dictionary, plus seed data |
| `public/` | Web interface (plain HTML, CSS, JavaScript, Chart.js for the report charts) |
| `firmware/esp32_relay/` | Arduino sketch for the ESP32 and relay (MQTT over TLS, port 8883) |
| `infra/cloudformation.yaml` | The whole AWS design as code: VPC, subnets, ALB, Auto Scaling, RDS Multi-AZ, S3, Secrets Manager, IoT policies, CloudWatch |
| `loadtest/` | k6 script for normal and spike traffic |
| `docs/` | Deployment guide, Telegram setup, security policy (NIST CSF 2.0), test plan, Progress II evidence, Progress III demo guide |

## Run it on your laptop (about 5 minutes)

You need Node.js 20 or newer and Docker (for MySQL).

```bash
cp .env.example .env
docker compose up -d db
npm install
npm start          # first start creates the tables and seed data (AUTO_INIT_DB=true)
```

Open http://localhost:3000.

| Account | Which button | Login | Password |
|---|---|---|---|
| Admin | **Admin log in** | `admin@utem.edu.my` | `Admin#12345` |
| Demo student | **Student log in** | `B032510025` | `Student#12345` |

If the admin cannot log in, an older `.env` probably cut the password at the `#`. Run
`node scripts/reset-password.js admin@utem.edu.my "Admin#12345"` once. In `.env` a password with `#` must be inside quotes.

Local mode uses **simulated ESP32 devices** (`IOT_MODE=simulate`). Book a slot that starts within 5 minutes, wait up to 15 seconds,
and open Admin > Lighting devices: the lamp turns on, an ACK is logged and Telegram is marked Skipped (no bot token yet).
Set `SIM_FAIL_RATE=0.5` in `.env` to watch the retry logic (up to 3 attempts, then an alert).

`npm run check` parses every JavaScript file.

## Feature map for the assignment

| Requirement | Where |
|---|---|
| CRUDS | Facilities (create, read, update, delete, search), bookings (create, read, reschedule, cancel, delete, search), users, devices |
| Complex query | `src/routes/reports.js` (JOIN, GROUP BY with HAVING, RANK() and ROW_NUMBER() window functions, NOT EXISTS) and the slot availability LEFT JOIN in `src/routes/facilities.js` |
| Report: frequency and statistics | Admin > Reports: bookings per day, hour, weekday, facility, top students, utilization, cancellation rate, CSV export |
| SDG | Energy panel in Reports: SDG 7 (affordable and clean energy) and SDG 13 (climate action), from lights that run only for booked slots |
| Smart feature | IoT lighting control: `src/services/iot.js`, `src/services/scheduler.js`, `firmware/` |
| Secure architecture | `infra/cloudformation.yaml`, `docs/SECURITY_POLICY.md` |
| Testing | `docs/TEST_PLAN.md`, `loadtest/` |

## Honest limitations

- The code was syntax-checked but **not run against a real MySQL server or AWS account** while it was written. Expect to fix small
  things on first run, and keep your screenshots of the working system as evidence.
- Lights switch on `LIGHT_LEAD_MIN` (default 5) minutes before the slot, as your Progress I screens show. Business rule BR17 says "at the slot start". Set `LIGHT_LEAD_MIN=0` or edit BR17 so the two agree.
- `light_command_logs.booking_id` is nullable so manual overrides can be logged. Your Progress I dictionary says NOT NULL. Update the dictionary.
- Rules marked * in your business rules (7 days ahead, 2 per day, 2 hour cancel cut-off, 2 minute offline) are configurable in `.env`.
- Login sessions are signed tokens in an HttpOnly cookie, so logging out clears the browser cookie but cannot revoke a stolen token before it expires (2 hours).
