# Test Plan and Results Sheet

Fill the **Result** and **Evidence** columns while you test. Take a screenshot of every PASS or FAIL for your logbook.
Base URL below: `APP` = the `AppUrl` output of the stack (or http://localhost:3000 locally).

## A. Functional tests

| ID | Scenario | Steps | Expected | Result | Evidence |
|---|---|---|---|---|---|
| FUN-01 | Register | Create an account with a valid student ID, email and a strong password | Account created, can log in | | |
| FUN-02 | Duplicate register | Register the same ID again | 409 "already registered" | | |
| FUN-03 | Login and logout | Log in, then log out | Dashboard opens. After logout, My bookings asks to log in | | |
| FUN-04 | Create booking | Pick a court, tomorrow, a free slot | Booking confirmed, receipt link works, row in `bookings` | | |
| FUN-05 | Double booking | Two browsers book the same slot at the same time | One succeeds, the other gets "someone just booked this slot" | | |
| FUN-06 | Daily limit (BR11) | Book 3 slots on the same day | Third is refused | | |
| FUN-07 | Advance limit (BR10) | Try a date 10 days ahead | Refused | | |
| FUN-08 | Reschedule | Change slot of a booking more than 2 hours ahead | Booking moves, new Telegram message | | |
| FUN-09 | Cancel (BR12) | Cancel a booking within 2 hours of start | Refused. Cancel earlier one succeeds and the slot is free again | | |
| FUN-10 | Facility CRUD | Admin adds, edits, uploads photo, searches and deletes a court | Each action works, photo opens from S3 | | |
| FUN-11 | Delete protection (BR14) | Delete a court that has an upcoming booking | Refused with a count of bookings | | |
| FUN-12 | Search | Search facilities and bookings by text, status, date | Matching rows only | | |
| FUN-13 | Complex query | Admin > Reports for 30 days | KPIs, charts, ranking, peak slot, top students shown | | |
| FUN-14 | CSV export | Download CSV | File opens, formulas are not executed (cells start with ') | | |
| FUN-15 | IoT ON | Book a slot starting in under 5 minutes | Within 15 s a command is logged, ACK received, lamp ON, Court Ready sent | | |
| FUN-16 | IoT OFF | Wait until the slot ends | OFF command, lamp OFF, booking becomes Completed after 10 minutes | | |
| FUN-17 | Back to back (BR17) | Book two consecutive slots on one court | Lights stay ON between them, OFF after the second | | |
| FUN-18 | Retry (BR19) | `SIM_FAIL_RATE=1` or unplug the ESP32, book a slot | 3 failed attempts logged, admin alert, `LIGHT_FAILED` in the audit log | | |
| FUN-19 | Offline (BR20) | Power off the ESP32 | Device shows Offline within about 2 minutes and a status log row is added | | |
| FUN-20 | Telegram | Link with the green button (or chat ID) and book | Linked message, confirmation, receipt and Court Ready arrive. Notifications table shows Sent | | |
| FUN-21 | Two login portals | Log in as a student on the Admin portal, then as admin on the Student portal | Both refused with a clear message | | |
| FUN-22 | Profile | Edit name, phone, faculty, photo. Change password with a wrong current password | Saved. Password change refused until correct and the two new passwords match | | |
| FUN-23 | Password stays | Log out and in again 3 times with the same password | Always works. Password never changes unless you press Change password | | |
| FUN-24 | Admin reset | Admin resets a student password | Temporary password shown once. Old password fails, new one works | | |
| FUN-25 | Receipt | Open a receipt, then cancel the booking and open it again | Neat PDF with QR code and court photo. After cancel it shows CANCELLED | | |
| FUN-26 | Photos | Upload a photo for a court and for your profile | Both appear. A renamed `.exe` is refused | | |
| FUN-27 | Courts | Open the facility page | 23 courts grouped by venue: Sport Hall, Luae Arena, Outdoor | | |
| FUN-28 | Monitoring page | Open Admin > Monitoring while generating traffic | Server, database, devices, Telegram, traffic chart and errors update every 5 seconds | | |

## B. Security tests

| ID | Scenario | Steps | Expected | Result | Evidence |
|---|---|---|---|---|---|
| SEC-01 | Password storage | Look at `users.password_hash` | bcrypt hash starting `$2` | | |
| SEC-02 | Brute force | Wrong password 21 times | HTTP 429 after 20 | | |
| SEC-03 | Audit of failures | Open Audit log | `LOGIN_FAILED` rows with IP | | |
| SEC-04 | RBAC | As a student call `GET /api/reports/overview` and `/api/admin/users` | 403 | | |
| SEC-05 | Booking ownership | Student A tries `GET /api/bookings/<id of student B>` | 403 | | |
| SEC-06 | HTTPS | `curl -I http://<domain>` (with a certificate) | 301 redirect to https | | |
| SEC-07 | SQL injection | Search for `' OR 1=1 --` | No error, no extra rows (parameterised queries) | | |
| SEC-08 | Stored XSS | Name a facility `<img src=x onerror=alert(1)>` | Shown as plain text, no alert | | |
| SEC-09 | Public access | Open an S3 object URL without a signature | AccessDenied | | |
| SEC-10 | Database exposure | From your laptop run `mysql -h <rds endpoint>` | Connection times out (private subnet) | | |
| SEC-11 | No SSH | Check web security group | No port 22 rule | | |
| SEC-12 | Upload check | Upload a `.exe` renamed `.jpg` | Refused | | |
| SEC-13 | CSRF header | `curl -X POST APP/api/auth/logout` without the header | 403 | | |
| SEC-14 | Invalid device cert | Flash an ESP32 with a revoked certificate | IoT Core refuses the connection (TC-IoT-05) | | |

## C. Traffic load tests

Preparation: all virtual users share one IP, so raise the limit for the test and restore it afterwards.
```bash
IDS=$(aws ec2 describe-instances --filters Name=tag:Name,Values=smartsports-web Name=instance-state-name,Values=running --query "Reservations[].Instances[].InstanceId" --output text)
aws ssm send-command --document-name AWS-RunShellScript --instance-ids $IDS \
  --parameters 'commands=["sed -i s/RATE_LIMIT_PER_MIN=.*/RATE_LIMIT_PER_MIN=100000/ /etc/smartsports.env","systemctl restart smartsports"]'
k6 run -e BASE_URL=http://<alb-dns> loadtest/k6-load.js        # or: sh loadtest/ab-quick.sh http://<alb-dns>
```
Open the CloudWatch dashboard `smartsports-overview` during the run and screenshot it at the start, the peak and the end.
Restore: set `RATE_LIMIT_PER_MIN=600` again and restart the service.

| Scenario | Load | Expected | Measured p95 | Error rate | Instances at peak | Evidence |
|---|---|---|---|---|---|---|
| Normal | 20 users for 5 min | p95 under 800 ms, errors under 1%, 2 instances | | | | |
| Spike | 20 to 300 users in 1 min, hold 3 min | p95 under 2.5 s, errors under 5%, Auto Scaling adds instances (up to 4), CPU alarm may fire, then scale in | | | | |

## D. Failure recovery tests

Record the time you started and the time the dashboard is healthy again. Keep the test traffic running at about 20 users.

| ID | Failure | How | Expected recovery | Time to recover | Evidence |
|---|---|---|---|---|---|
| REC-01 | Application crash | Session Manager: `sudo systemctl stop smartsports` on one instance | Health check fails, load balancer stops sending traffic, users unaffected through the other zone, ALB unhealthy alarm email, Auto Scaling replaces the instance | | |
| REC-02 | Instance loss | `aws ec2 terminate-instances --instance-ids <one web instance>` | Auto Scaling launches a replacement in a private subnet and it joins the target group | | |
| REC-03 | Zone web failure | Terminate or stop all web servers in AZ 1 | Site stays up through AZ 2. Auto Scaling rebuilds capacity in both zones | | |
| REC-04 | Database failover | `aws rds reboot-db-instance --db-instance-identifier smartsports-db --force-failover` | RDS promotes the standby in the other zone, usually 60 to 120 seconds. The app reconnects by itself, a few requests fail meanwhile. No data lost | | |
| REC-05 | Device loss | Power off one ESP32 during a booking | Device Offline within 2 minutes, retries, admin alert. Other courts unaffected | | |
| REC-06 | Data restore | Restore the latest RDS snapshot to a new instance (do not overwrite) | Data present in the restored copy | | |

Write one incident log entry per failure: date, what happened, which alarm or log showed it, how it was fixed, time to recover, what to improve.

## E. IoT hardware tests (from your Progress I test design)

| ID | Test | Expected |
|---|---|---|
| TC-IoT-01 | Set the GPIO HIGH | Relay clicks and the bulb turns on |
| TC-IoT-02 | ESP32 connects to AWS IoT Core with its certificate | MQTT connected on 8883 |
| TC-IoT-03 | ESP32 publishes a heartbeat | MQTT test client in the console receives it |
| TC-IoT-04 | Publish `{"cmdId":1,"command":"OFF"}` to `utem/sports/court/RELAY_01/cmd` | Relay opens and an ACK is published |
| TC-IoT-05 | Connect with an invalid certificate | Connection refused |
