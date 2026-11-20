#!/bin/sh
# Creates the AWS IoT Things RELAY_01 ... RELAY_NN (one per court in the app) and, optionally, a certificate for each.
# Usage:  sh infra/create-iot-things.sh 23            (things only)
#         sh infra/create-iot-things.sh 23 certs      (things + certificate and key files in ./iot-certs, attached to the device policy)
# Run it in AWS CloudShell. Safe to run again. Never commit the certs folder.
N="${1:-23}"; MODE="$2"
mkdir -p iot-certs
i=1
while [ "$i" -le "$N" ]; do
  NAME=$(printf 'RELAY_%02d' "$i")
  aws iot create-thing --thing-name "$NAME" >/dev/null && echo "thing $NAME ok"
  if [ "$MODE" = "certs" ] && [ ! -f "iot-certs/$NAME.cert.pem" ]; then
    ARN=$(aws iot create-keys-and-certificate --set-as-active --certificate-pem-outfile "iot-certs/$NAME.cert.pem" \
          --public-key-outfile "iot-certs/$NAME.pub.pem" --private-key-outfile "iot-certs/$NAME.key.pem" --query certificateArn --output text)
    aws iot attach-policy --policy-name smartsports-device-policy --target "$ARN"
    aws iot attach-thing-principal --thing-name "$NAME" --principal "$ARN"
    echo "certificate for $NAME attached"
  fi
  i=$((i + 1))
done
