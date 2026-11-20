#!/bin/sh
# Quick alternative to k6 with Apache Bench:  sh loadtest/ab-quick.sh http://<alb-dns>
URL="${1:?usage: ab-quick.sh http://alb-dns}"
echo "== normal: 2000 requests, 20 at a time =="
ab -n 2000 -c 20 "$URL/api/facilities"
echo "== spike: 20000 requests, 200 at a time =="
ab -n 20000 -c 200 "$URL/api/facilities"
