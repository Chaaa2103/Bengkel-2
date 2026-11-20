# Deploying to AWS

Region: **us-east-1** (same as your Progress I cost estimate). Time needed: about 30 minutes, mostly waiting for the NAT gateways and the Multi-AZ database.
Cost: about USD 155 per month in your estimate, roughly USD 5 per day. **Delete the stack when you finish a demo or test day** (step 8).

## 0. What you need
AWS account, AWS CLI v2 configured (`aws configure`), `zip`, `jq`. An email address for alarm messages.

## 1. Upload the application
```bash
cd smart-sports-booking
zip -r smartsports-app.zip . -x "node_modules/*" ".env" "data/*" "*.zip"
aws s3 mb s3://YOUR-UNIQUE-ARTIFACT-BUCKET --region us-east-1
aws s3api put-public-access-block --bucket YOUR-UNIQUE-ARTIFACT-BUCKET \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3 cp smartsports-app.zip s3://YOUR-UNIQUE-ARTIFACT-BUCKET/artifacts/smartsports-app.zip
```

## 2. Create the stack
```bash
aws cloudformation deploy --region us-east-1 --stack-name smartsports \
  --template-file infra/cloudformation.yaml --capabilities CAPABILITY_IAM \
  --parameter-overrides ArtifactBucket=YOUR-UNIQUE-ARTIFACT-BUCKET AlertEmail=you@example.com \
    AdminEmail=admin@utem.edu.my AdminPassword='ChooseALongPassword#1'
```
Confirm the SNS email you receive. When the stack finishes:
```bash
aws cloudformation describe-stacks --stack-name smartsports --query "Stacks[0].Outputs" --output table
```
Open `AppUrl`. The first web server creates the tables and the admin account. Instances need up to 10 minutes after the stack
finishes to pass health checks. Log in as the admin.

If an instance does not become healthy, open Systems Manager > Session Manager, connect to it and run
`tail -50 /var/log/smartsports/app.log` and `tail -50 /var/log/cloud-init-output.log`.

## 3. HTTPS (required for real use)
Request a certificate in AWS Certificate Manager for your domain, validate it, then update the stack with
`--parameter-overrides ... CertificateArn=arn:aws:acm:...`. Port 80 then redirects to 443, cookies become `Secure`, and the TLS 1.3 policy applies.
Without a domain the stack runs HTTP only. Write this down as a documented exception in your security policy, for lab use only.

## 4. Telegram bot
1. In Telegram, message **@BotFather**, send `/newbot`, copy the token.
2. Secrets Manager > secret `smartsports/app` > Retrieve value > Edit: set `TELEGRAM_BOT_TOKEN`.
3. Restart the servers: `aws autoscaling start-instance-refresh --auto-scaling-group-name <AutoScalingGroup output>`.
4. Each student sends `/start` to the bot, finds their chat ID (for example with @userinfobot), and saves it in the profile page.

## 5. Real ESP32 devices (optional, switches `IotMode` to `aws`)
```bash
aws iot describe-endpoint --endpoint-type iot:Data-ATS --query endpointAddress --output text
curl -o AmazonRootCA1.pem https://www.amazontrust.com/repository/AmazonRootCA1.pem

# one certificate per device (repeat for RELAY_02 .. RELAY_04)
ARN=$(aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile relay01.cert.pem --public-key-outfile relay01.pub.pem --private-key-outfile relay01.key.pem \
  --query certificateArn --output text)
aws iot attach-policy --policy-name smartsports-device-policy --target "$ARN"
aws iot attach-thing-principal --thing-name RELAY_01 --principal "$ARN"

# certificate for the web servers (the backend)
BARN=$(aws iot create-keys-and-certificate --set-as-active \
  --certificate-pem-outfile backend.cert.pem --public-key-outfile backend.pub.pem --private-key-outfile backend.key.pem \
  --query certificateArn --output text)
aws iot attach-policy --policy-name smartsports-backend-policy --target "$BARN"
aws iot attach-thing-principal --thing-name smartsports-backend --principal "$BARN"
jq -n --rawfile cert backend.cert.pem --rawfile key backend.key.pem --rawfile ca AmazonRootCA1.pem '{cert:$cert,key:$key,ca:$ca}' > iot-secret.json
aws secretsmanager put-secret-value --secret-id smartsports/iot-backend --secret-string file://iot-secret.json
```
Re-run the stack update with `IotMode=aws IotEndpoint=<endpoint>`, then paste the Root CA, the device certificate and key and the endpoint into
`firmware/esp32_relay/esp32_relay.ino` (on your own copy), set `THING_NAME`, and flash the ESP32. Never commit `.pem` files.
Wiring: relay IN to GPIO 26, relay VCC and GND to the ESP32, mains live wire through the relay COM and NO terminals. Ask your supervisor to check the mains wiring.

## 6. Verify (also your evidence)
- `AppUrl/health` returns `{"status":"ok","db":"up"}`.
- EC2 > Instances: two `smartsports-web` instances, one per Availability Zone, no public IP.
- RDS: Multi-AZ = Yes, Encryption = Enabled, Publicly accessible = No.
- S3 bucket: Block public access = On, default encryption on.
- CloudWatch > Dashboards > `smartsports-overview`, and Alarms.
- VPC > Flow logs exist and `/smartsports/vpc-flow` has data.

## 7. Updating the application
Upload a new zip with the same key, then `aws autoscaling start-instance-refresh --auto-scaling-group-name <name>`.

## 8. Clean up (stops the charges)
```bash
aws cloudformation delete-stack --stack-name smartsports
```
The files bucket is retained on purpose. Empty and delete it by hand when you no longer need the data. A final database snapshot is kept. Delete it too if not needed.
