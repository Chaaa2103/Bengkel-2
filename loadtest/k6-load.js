// k6 load test: "normal" traffic then a "spike". Run:  k6 run -e BASE_URL=http://<alb-dns> loadtest/k6-load.js
// Before a big run raise the app rate limit (see docs/TEST_PLAN.md) because all virtual users share one IP address.
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE = __ENV.BASE_URL;
if (!BASE) throw new Error('Set BASE_URL, e.g. k6 run -e BASE_URL=http://my-alb.us-east-1.elb.amazonaws.com loadtest/k6-load.js');

export const options = {
  scenarios: {
    normal: { executor: 'constant-vus', vus: 20, duration: '5m', exec: 'browse', tags: { scenario: 'normal' } },
    spike: {
      executor: 'ramping-vus', startTime: '6m', exec: 'browse', tags: { scenario: 'spike' },
      stages: [{ duration: '1m', target: 20 }, { duration: '1m', target: 300 }, { duration: '3m', target: 300 }, { duration: '1m', target: 20 }, { duration: '1m', target: 0 }],
    },
  },
  thresholds: {
    'http_req_failed{scenario:normal}': ['rate<0.01'],
    'http_req_duration{scenario:normal}': ['p(95)<800'],
    'http_req_failed{scenario:spike}': ['rate<0.05'],
    'http_req_duration{scenario:spike}': ['p(95)<2500'],
  },
};

const pad = (n) => String(n).padStart(2, '0');
function plusDays(n) { const d = new Date(Date.now() + n * 864e5); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

// A student browsing: list courts, open one, load its slots. These are the read-heavy calls that dominate real traffic.
export function browse() {
  const list = http.get(`${BASE}/api/facilities`);
  check(list, { 'facilities 200': (r) => r.status === 200 });
  if (list.status === 200) {
    const courts = list.json();
    if (courts.length) {
      const id = courts[Math.floor(Math.random() * courts.length)].facility_id;
      const a = http.get(`${BASE}/api/facilities/${id}/availability?date=${plusDays(1 + Math.floor(Math.random() * 5))}`);
      check(a, { 'availability 200': (r) => r.status === 200 });
    }
  }
  http.get(`${BASE}/health`);
  sleep(1 + Math.random() * 2);
}
