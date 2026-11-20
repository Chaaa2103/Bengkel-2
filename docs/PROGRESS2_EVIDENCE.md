# Progress II checklist and logbook evidence

Progress II asks for (a) an initial prototype with database connection, login and CRUDS, and (b) the cloud infrastructure implemented,
with logbook entries made of diagrams, configurations and screenshots.

## Evidence to capture

| # | What to screenshot | Shows |
|---|---|---|
| 1 | CloudFormation stack, status CREATE_COMPLETE, Resources tab | Infrastructure implemented |
| 2 | VPC > Resource map | 2 AZs, 2 public + 2 private subnets, route tables, IGW, 2 NAT |
| 3 | Route tables: public (0.0.0.0/0 to IGW), private (0.0.0.0/0 to NAT of own zone) | Subnet separation and routes |
| 4 | Security groups ALB, Web, DB with their inbound rules | Least privilege network |
| 5 | EC2 instances list with Availability Zone column | Web server site 1 and site 2 in different zones |
| 6 | ALB, listeners, target group with Healthy targets | Load balancing across AZs |
| 7 | Auto Scaling group: min, max, desired, scaling policies, activity history | Auto scaling |
| 8 | RDS: Multi-AZ, encryption, private, parameter group `require_secure_transport` | Database server and encryption |
| 9 | Secrets Manager: secrets list (never show the values) | Credentials stored securely |
| 10 | S3 bucket: encryption, public access block, objects in `facilities/` and `receipts/` | Files, images, archives |
| 11 | CloudWatch dashboard, alarms, log stream, flow logs | Monitoring and compliance |
| 12 | IoT Core: Things, certificates, policies, MQTT test client | Smart feature |
| 13 | Web app: login, facility list, booking, My bookings, admin facilities CRUD, reports, devices | Prototype |
| 14 | Database tables with data (MySQL client through Session Manager) | Database connection |
| 15 | Load test results and dashboard at the spike | Traffic tests |
| 16 | Failure tests: before, during and after for each REC test | Recovery |

## Where each requirement is covered

| Requirement | File or place |
|---|---|
| Secure architecture for web and database servers | `infra/cloudformation.yaml` |
| Encrypt in transit and at rest | Security policy PR.DS-01 and PR.DS-02 |
| VPC, subnets, routes, 2 AZs (AZ1: web 1 + DB, AZ2: web 2) | Template. The Multi-AZ database keeps its standby in the other zone, AWS chooses which zone starts as primary, so check it in the RDS console and say which zone it was |
| Web servers, auto scaling, load balancing | Template: launch template, Auto Scaling group, ALB |
| Database credentials stored securely | RDS-managed secret in Secrets Manager |
| Files, images, archives | S3 bucket with an `archives/` prefix moved to Glacier after 90 days |
| Monitoring and compliance | CloudWatch agent, alarms, dashboard, flow logs, audit log, optional GuardDuty |
| Tests for normal and spike traffic and recovery | `docs/TEST_PLAN.md`, `loadtest/` |
| Security policy with NIST CSF 2.0 Protect and Detect | `docs/SECURITY_POLICY.md` |

## Sample logbook entry (edit to match what you really did)

**Task:** Build the initial prototype (login, database connection, CRUDS) and deploy the cloud infrastructure.

**Problems and solutions:**
1. Double booking could happen if two students clicked at the same time. I added a unique key on facility, slot, date and an active flag, plus a transaction. Tested with two browsers.
2. Auto Scaling would start the light scheduler on every server and send duplicate commands. I used a MySQL named lock so only one server runs each cycle.
3. Database passwords must not sit in the code. I stored them in AWS Secrets Manager and gave each server an IAM role that can read only the needed secrets.
4. The web servers are in private subnets with no internet. I used NAT gateways in each zone for outbound traffic and Session Manager instead of SSH.

**Evidence / AI used:** screenshots 1 to 16 above, CloudFormation template, test results sheet. AI used: Claude to help write the application code, CloudFormation template, security policy and test plan. I reviewed, ran and corrected the output myself.
