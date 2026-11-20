# Security Policy: Smart Sports Facility Booking System

Framework: NIST Cybersecurity Framework (CSF) 2.0. Core Functions covered: **Protect (PR)** and **Detect (DE)**.
Scope: the web application, Amazon RDS database, Amazon S3 storage, AWS IoT Core, the ESP32 controllers and the AWS account that hosts them.
Owner: Group 11 (Cloud Security: Nur Basyirah). Review: at the start of each project phase and after any incident.

> The CSF identifiers below are the ones commonly used for these topics. Compare them with the list in **Appendix A** of your brief and
> replace any that your lecturer expects. The control content stays the same, only the label changes.

## Policy template (one block per subcategory)

### PROTECT

**PR.AA-01 Identities and credentials are managed**
- *Policy statement:* Every user, service and device has its own identity. Secrets are never stored in source code or on servers.
- *Implementation:* Students and admins have separate accounts with unique ID and email. Passwords are hashed with bcrypt (cost 12), minimum 8 characters with letters and numbers (BR02).
  Database credentials are generated and rotated by RDS in AWS Secrets Manager. The session signing key, admin password and Telegram token are in a second secret.
  Each ESP32 has its own X.509 certificate attached to its own IoT Thing. Admins can deactivate users, which takes effect on the next request.
- *Evidence:* `src/routes/auth.js`, Secrets Manager screenshot, IoT Core Things and certificates screenshot.

**PR.AA-03 Users, services and devices are authenticated**
- *Policy statement:* Access requires authentication that matches the risk.
- *Implementation:* Login with HttpOnly, SameSite cookie holding a 2 hour signed token. Login and registration are limited to 20 attempts per 15 minutes per IP.
  Failed logins are written to the audit log. Devices authenticate to AWS IoT Core with mutual TLS (client certificate). The load balancer drops malformed headers.
- *Evidence:* Audit log screenshot with `LOGIN_FAILED`, test case SEC-02, SEC-03.

**PR.AA-05 Access permissions follow least privilege and separation of duties**
- *Policy statement:* People, services and devices get only the access they need.
- *Implementation:* Role-based access control in the API: Students manage only their own bookings (BR05), admins manage facilities, reports, devices and users (BR06).
  The web server IAM role may only read three secrets, read and write two S3 prefixes and read one artifact object. Each ESP32 may only publish to its own `ack` and `heartbeat` topics and
  subscribe to its own `cmd` topic. The devices accept only the commands ON and OFF. No SSH: administration uses Systems Manager Session Manager.
- *Evidence:* IAM role policy JSON, IoT policy JSON, test cases SEC-04, SEC-05.

**PR.DS-01 Data at rest is protected**
- *Policy statement:* Stored data is encrypted and protected from loss.
- *Implementation:* RDS MySQL encryption (AWS managed key), encrypted EBS volumes, S3 server-side encryption (SSE-S3) with versioning and public access blocked, 7 day automated database backups,
  Multi-AZ replication. Receipts and photos are opened only through 5 minute signed URLs. File uploads are checked by their real file type and size.
- *Evidence:* RDS "Encryption: Enabled" screenshot, S3 encryption and block-public-access screenshots, test cases SEC-07, SEC-08.

**PR.DS-02 Data in transit is protected**
- *Policy statement:* Data that travels over a network is encrypted.
- *Implementation:* HTTPS with TLS 1.3 policy at the load balancer and HTTP-to-HTTPS redirect when a certificate is configured (a lab without a domain is a documented exception).
  The web server connects to RDS over TLS, verified against the RDS CA bundle, and the database refuses unencrypted connections (`require_secure_transport=1`).
  The S3 bucket policy denies requests that are not TLS. Devices and servers use MQTT over TLS on port 8883. HSTS and a Content Security Policy are sent by the app.
- *Evidence:* ALB listener screenshot, DB parameter group, bucket policy, test cases SEC-06, SEC-09.

**PR.IR-01 Networks and environments are protected from unauthorized access**
- *Policy statement:* Systems sit in segmented networks and only required traffic is allowed.
- *Implementation:* One VPC (10.0.0.0/16), two Availability Zones, public subnets for the load balancer and NAT gateways, private subnets for web servers and database.
  Security groups: internet to load balancer on 80 and 443 only, load balancer to web servers on 3000 only, web servers to database on 3306 only. No public IP on servers or database.
  Private subnets reach the internet only through the NAT gateway of their own zone.
- *Evidence:* VPC resource map screenshot, security group rules, route tables, test case SEC-10.

### DETECT

**DE.CM-01 Networks and network services are monitored to find adverse events**
- *Policy statement:* Network activity is logged and watched.
- *Implementation:* VPC Flow Logs (all traffic) to CloudWatch Logs for 30 days. Load balancer metrics (requests, 5xx errors, unhealthy hosts) feed CloudWatch alarms that email the team through SNS.
  Optional Amazon GuardDuty (`EnableGuardDuty=true`) for threat findings.
- *Evidence:* Flow log group screenshot, alarm list, SNS email, GuardDuty findings page.

**DE.CM-09 Computing hardware and software, runtime environments and their data are monitored**
- *Policy statement:* Servers, applications, databases and devices are monitored for abnormal behavior.
- *Implementation:* The CloudWatch agent ships application logs (JSON) and memory and disk metrics. A metric filter counts application errors and raises an alarm. Alarms cover web CPU, database CPU and free storage.
  RDS exports error and slow query logs. The scheduler marks ESP32 devices Offline after 2 minutes without a heartbeat (BR20) and alerts the admin when a light command still fails after 3 attempts (BR19).
  Logins, bookings, cancellations, facility changes and light commands are stored in the audit log (BR25).
- *Evidence:* Dashboard `smartsports-overview`, alarms, application log stream, Admin > Audit log, Admin > Lighting devices.

**DE.AE-02 Potentially adverse events are analyzed**
- *Policy statement:* Alerts are reviewed and classified.
- *Implementation:* A named team member reviews alarm emails and the audit log. Repeated `LOGIN_FAILED` entries from one address, repeated `LIGHT_FAILED` entries or a spike in 5xx errors are logged in the incident log with time, cause and action.
- *Evidence:* Completed incident log entry from the failure-recovery test (docs/TEST_PLAN.md section D).

## Exceptions and known gaps
| Item | Reason | Plan |
|---|---|---|
| HTTP only without a domain | No certificate in a student lab | Use `CertificateArn` for the demo or real use |
| No AWS WAF | Cost | Rate limiting in the app. Add WAF managed rules if budget allows |
| Stateless session cannot be revoked early | Keeps web servers independent for auto scaling | Short 2 hour life and immediate user deactivation check |

## Incident handling (short form)
1. Detect: alarm email or audit log review. 2. Contain: deactivate the user, rotate the secret, or detach the instance from the target group.
3. Recover: replace the instance (Auto Scaling) or restore the database snapshot. 4. Record: time, cause, fix and follow-up in the incident log.
