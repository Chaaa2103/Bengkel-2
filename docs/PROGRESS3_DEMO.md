# Progress III: live demo guide (Week 8 to 12) and internal evaluator demo (Week 13)

## 1. What the assessors look for and where you show it

| Requirement | Where you show it | Evidence for the logbook |
|---|---|---|
| **(a) Full functionality: CRUDS, login, storage** | Facilities add / edit / photo / search / delete. Bookings create / change / cancel / delete. Profile with photo. Receipt PDF from S3. | Screenshots of each, S3 bucket with `facilities/`, `profiles/`, `receipts/` |
| **(b) Secure access** | Two login portals (Student and Admin), role check, failed login limit, audit log, private subnets, security groups, Secrets Manager, HTTPS, no SSH | `docs/SECURITY_POLICY.md`, security group rules, SEC-01 to SEC-14 results |
| **(c) Monitoring tools** | App page **Admin > Monitoring**, CloudWatch dashboard `smartsports-overview`, alarms and SNS email, VPC flow logs, audit log | Dashboard screenshots before, during and after load |
| **(d) Performance testing and fault handling trials** | k6 normal and spike run, Auto Scaling activity, REC-01 to REC-06 failure tests | Section C and D of `docs/TEST_PLAN.md`, incident log |
| **Week 13: 100% of services, configuration, network** | Walk through every service in the table in section 3 | Final report, all screenshots |
| **Week 13: every member presents all services** | Everybody learns section 3. The evaluator can ask any member about any service | Rehearsal |

## 2. Live demo script (about 20 minutes)

Roles: **Basyirah** (network, security), **Sharven** (EC2, RDS, backend), **Harith** (website, architecture), **Amir** (IoT). Everyone must still be able to answer questions on everything.

| Min | Who | What to do and say |
|---|---|---|
| 0 | Harith | Show the architecture diagram, then open the website address (the load balancer). |
| 2 | Harith | **Student log in.** Register a new student. Link Telegram (green button, Start in Telegram). Show the profile with photo, phone, faculty. |
| 4 | Harith | Book a court. Show the Telegram confirmation, then the receipt PDF (it is stored in S3). Change the slot, then cancel one. Show a refused double booking from a second browser. |
| 7 | Amir | Book a slot that starts in under 5 minutes. Open **Admin > Lighting devices**: command sent, ACK, lamp on. Show the ESP32 and relay switching a real light, and the Telegram "court is ready" message. Show AWS IoT Core MQTT test client. |
| 10 | Sharven | **Admin log in.** Facilities: add a court, upload a photo, search, edit, try to delete one with a booking (refused). Reports: charts, ranking, CSV, SDG energy panel. Users: reset a password. |
| 13 | Basyirah | Security: audit log (failed login), security groups, private subnets, RDS not public, Secrets Manager (names only), S3 encryption and block public access. |
| 15 | Basyirah | Monitoring: **Admin > Monitoring** (note the "Server that answered" card, refresh to see the other zone), CloudWatch dashboard, alarm list. |
| 17 | Sharven | Fault handling: stop the app on one server (or terminate an instance) while the site stays up. Show the unhealthy alarm email and Auto Scaling replacing the server. Optionally fail over the database. |
| 19 | All | Show the load test result and the scaling during the spike. Summary and questions. |

## 3. Service cheat sheet (everyone must be able to say this)

| Service | What it does in our system | How to show it |
|---|---|---|
| **VPC (10.0.0.0/16)** | Our private network on AWS | VPC > Resource map |
| **Public subnets (10.0.1.0/24, 10.0.3.0/24)** | Hold the load balancer and NAT gateways, reachable from the internet | Subnet list |
| **Private subnets (10.0.2.0/24, 10.0.4.0/24)** | Hold web servers and database, not reachable from the internet | Subnet list, EC2 has no public IP |
| **Internet Gateway** | The door between the VPC and the internet | Route table: 0.0.0.0/0 to igw |
| **NAT Gateway (one per zone)** | Lets private servers go out (install packages, reach Telegram and IoT Core) but nobody can come in | Private route table |
| **Security groups** | Firewalls: internet to load balancer, load balancer to web 3000, web to database 3306 | Inbound rules |
| **Application Load Balancer** | Shares student traffic between the two web servers and checks `/health` | Target group with Healthy targets |
| **EC2 + Auto Scaling** | The web servers. Auto Scaling adds servers when CPU or requests rise and replaces broken ones | Activity history |
| **RDS MySQL Multi-AZ** | The database, encrypted, with a standby copy in the other zone that takes over in 1 to 2 minutes | RDS console |
| **S3** | Stores facility photos, profile photos and receipt PDFs. Private, encrypted, versioned | Bucket and signed link |
| **Secrets Manager** | Keeps the database password, session key and Telegram token out of the code | Secrets list (never show values) |
| **IAM role** | Gives each web server only the permissions it needs | Role policy |
| **CloudWatch** | Logs, metrics, dashboard and alarms | Dashboard, alarms |
| **SNS** | Emails the team when an alarm fires | Subscription, email |
| **VPC Flow Logs** | Records network traffic for security checks | Log group |
| **AWS IoT Core** | Secure messaging (MQTT over TLS, port 8883) between the server and each ESP32 | MQTT test client |
| **ESP32 + relay** | Receives ON/OFF, switches the light, replies with an ACK, sends a heartbeat | Live demo |
| **Telegram bot** | Sends confirmation and court-ready messages. Linked by a one-time code | Phone |

Typical questions and short answers:
- *Why two zones?* If one zone fails the other keeps the site running.
- *Why a NAT gateway, and why two?* Private servers need to go out. One per zone so a zone failure does not cut the other.
- *How do you stop double booking?* A unique rule in the database on facility, slot and date, inside a transaction.
- *How do you stop duplicate light commands with many servers?* A database lock lets only one server run the scheduler at a time.
- *Where is the password stored?* Only a bcrypt hash. Database credentials are in Secrets Manager.
- *What if the ESP32 does not answer?* Three retries, then Failed, an admin alert, and the device shows Offline after 2 minutes.
- *How is data encrypted?* At rest: RDS, disks, S3. In transit: HTTPS to the browser, TLS to the database, MQTT over TLS to the device.

## 4. Logbook entries (write one per week, then add screenshots)

**Deployment**
- Task: deploy the application on AWS. Problems: private servers had no internet, solved with NAT gateways. The first start must create the tables, solved with the auto-initialisation. A password containing `#` was cut off in `.env`, solved by quoting it.
- Evidence: CloudFormation stack, EC2 in two zones, target group healthy, `/health` page, screenshots of the running site.

**Monitoring**
- Task: set up monitoring. Done: CloudWatch dashboard, alarms (unhealthy hosts, 5xx, CPU, database CPU and storage, application errors), SNS email, VPC flow logs, app Monitoring page, audit log.
- Evidence: dashboard before and during the test, an alarm email, the Monitoring page, flow log entries.

**Testing**
- Task: functional, security, load and failure tests from `docs/TEST_PLAN.md`.
- Evidence: filled results tables, k6 summary, CloudWatch during the spike, Auto Scaling activity, one incident log entry per failure with the time to recover.

AI used: Claude helped write code, templates and documents. State this honestly in the AI declaration and say what you checked yourselves.

## 5. Day-before and one-hour-before checklist
- [ ] Stack running (about 25 minutes to create, so start it at least 1 hour before). Admin and a student can log in at the load balancer address.
- [ ] `/health` shows ok. Monitoring page shows the database OK, devices online and the Telegram bot name.
- [ ] Telegram: your phone has linked the demo student. A test message arrives.
- [ ] ESP32 powered, connected, shown Online. The relay clicks. A lamp is connected (mains wiring checked by your supervisor).
- [ ] CloudWatch dashboard, EC2, RDS, S3 and IoT Core tabs already open and signed in.
- [ ] Alarm email subscription confirmed.
- [ ] **Backup plan:** the same app running on a laptop (`npm start`) in case the internet fails.
- [ ] Delete the stack after the demo to stop the charges.
