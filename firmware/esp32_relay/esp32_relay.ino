/*
  Smart Sports Facility Booking - ESP32 relay controller (Progress II)
  Libraries (Arduino Library Manager): PubSubClient, ArduinoJson (v7)
  Board: ESP32 Dev Module.  Relay IN pin -> GPIO 26 (change RELAY_PIN if you wire it differently).

  What it does
   1. Connects to Wi-Fi, then to AWS IoT Core on port 8883 using TLS and its own X.509 certificate.
   2. Subscribes to  utem/sports/court/<THING_NAME>/cmd   and switches the relay when it receives {"cmdId":12,"command":"ON"} or "OFF".
   3. Replies on     utem/sports/court/<THING_NAME>/ack   with {"cmdId":12,"state":"ON"} so the server knows the light really changed.
   4. Publishes a heartbeat to .../heartbeat every 30 seconds. The server marks the device Offline after 2 minutes without one.
   5. Fail-safe: the relay is OFF at boot and whenever the connection is lost for more than FAILSAFE_MS.

  SECURITY: never commit real certificates. Paste them below only on your own copy, or store them in flash (SPIFFS/LittleFS).
*/
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ---------- settings ----------
const char* WIFI_SSID     = "YOUR_WIFI";
const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
const char* AWS_ENDPOINT  = "xxxxxxxxxxxxxx-ats.iot.us-east-1.amazonaws.com";   // aws iot describe-endpoint --endpoint-type iot:Data-ATS
const char* THING_NAME    = "RELAY_01";                                         // must match iot_devices.thing_name
const int   RELAY_PIN     = 26;
const bool  RELAY_ACTIVE_LOW = false;     // many relay boards switch ON when the pin is LOW
const unsigned long HEARTBEAT_MS = 30000;
const unsigned long FAILSAFE_MS  = 10UL * 60UL * 1000UL;
const char* FIRMWARE      = "1.0.0";

// Amazon Root CA 1, device certificate and private key from AWS IoT Core (paste the full PEM text).
const char AWS_CA[]   PROGMEM = R"EOF(-----BEGIN CERTIFICATE-----
PASTE_AMAZON_ROOT_CA1_HERE
-----END CERTIFICATE-----)EOF";
const char DEVICE_CERT[] PROGMEM = R"EOF(-----BEGIN CERTIFICATE-----
PASTE_DEVICE_CERTIFICATE_HERE
-----END CERTIFICATE-----)EOF";
const char DEVICE_KEY[]  PROGMEM = R"EOF(-----BEGIN RSA PRIVATE KEY-----
PASTE_DEVICE_PRIVATE_KEY_HERE
-----END RSA PRIVATE KEY-----)EOF";

WiFiClientSecure net;
PubSubClient mqtt(net);
String topicCmd, topicAck, topicBeat;
bool lightOn = false;
unsigned long lastBeat = 0, lastConnected = 0;

void setRelay(bool on) {
  lightOn = on;
  digitalWrite(RELAY_PIN, (on != RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void publishJson(const String& topic, JsonDocument& doc) {
  char buf[200];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topic.c_str(), (const uint8_t*)buf, n, false);
}

void onMessage(char* topic, byte* payload, unsigned int len) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, len)) return;               // ignore malformed JSON
  const char* cmd = doc["command"];
  if (!cmd) return;
  if (strcmp(cmd, "ON") == 0) setRelay(true);
  else if (strcmp(cmd, "OFF") == 0) setRelay(false);
  else return;                                                   // only ON/OFF are allowed (least privilege)
  JsonDocument ack;
  ack["cmdId"] = doc["cmdId"];
  ack["state"] = lightOn ? "ON" : "OFF";
  publishJson(topicAck, ack);
  Serial.printf("[CMD] %s -> relay %s\n", cmd, lightOn ? "ON" : "OFF");
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  if (WiFi.status() == WL_CONNECTED) configTime(0, 0, "pool.ntp.org", "time.google.com");   // TLS needs the correct time
}

bool connectAws() {
  if (mqtt.connected()) return true;
  if (!mqtt.connect(THING_NAME)) { Serial.printf("[AWS] connect failed, rc=%d\n", mqtt.state()); return false; }
  mqtt.subscribe(topicCmd.c_str(), 1);
  lastConnected = millis();
  Serial.println("[AWS] connected and subscribed");
  return true;
}

void setup() {
  Serial.begin(115200);
  pinMode(RELAY_PIN, OUTPUT);
  setRelay(false);                                               // fail-safe: lights OFF at boot
  topicCmd  = String("utem/sports/court/") + THING_NAME + "/cmd";
  topicAck  = String("utem/sports/court/") + THING_NAME + "/ack";
  topicBeat = String("utem/sports/court/") + THING_NAME + "/heartbeat";
  net.setCACert(AWS_CA);
  net.setCertificate(DEVICE_CERT);
  net.setPrivateKey(DEVICE_KEY);
  mqtt.setServer(AWS_ENDPOINT, 8883);
  mqtt.setCallback(onMessage);
  mqtt.setKeepAlive(30);
}

void loop() {
  connectWifi();
  if (WiFi.status() == WL_CONNECTED && !connectAws()) delay(3000);
  mqtt.loop();
  if (mqtt.connected()) {
    lastConnected = millis();
    if (millis() - lastBeat > HEARTBEAT_MS) {
      lastBeat = millis();
      JsonDocument beat;
      beat["state"] = lightOn ? "ON" : "OFF";
      beat["fw"] = FIRMWARE;
      beat["rssi"] = WiFi.RSSI();
      publishJson(topicBeat, beat);
    }
  } else if (lightOn && millis() - lastConnected > FAILSAFE_MS) {
    setRelay(false);                                             // lost contact for too long: switch the lights off
  }
}
