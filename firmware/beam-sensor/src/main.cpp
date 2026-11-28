#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <ESP8266mDNS.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <LittleFS.h>
#include <BeamDetector.h>

// Beam sensor: reads the beam every 20 ms, turns readings into events, and reports them to the controller over WiFi.
// It still prints "<reading>,<microseconds>" on USB serial, so the bench tools keep working.

#define SENSOR_VERSION "1.0.0"
#ifndef CONTROLLER_HOST
#define CONTROLLER_HOST ""
#endif

const unsigned long SAMPLE_MS = 20, HEARTBEAT_MS = 1000, MEASURE_MS = 3000, RESOLVE_RETRY_MS = 10000;
const int MEASURE_CAP = 256;

WebSocketsClient ws;
BeamDetector detector({747, 235});
ChangeWatch watch;
bool calibrated = false, connected = false, started = false;
IPAddress controllerIp;
unsigned long lastSample = 0, lastHeartbeat = 0, lastResolve = 0;
int lastLevel = 0;

int measureBuf[MEASURE_CAP]; int measureN = 0; bool measuring = false; unsigned long measureStart = 0;

uint32_t lastMicros = 0; uint64_t microsAcc = 0;
double nowMs() {   // sensor clock in ms, carried across the 71-minute micros() wrap
  uint32_t m = micros(); microsAcc += (uint32_t)(m - lastMicros); lastMicros = m;
  return microsAcc / 1000.0;
}

void send(JsonDocument& doc) {
  if (!connected) return;
  String s; serializeJson(doc, s); ws.sendTXT(s);
}

bool loadLevels() {
  File f = LittleFS.open("/levels.json", "r");
  if (!f) return false;
  JsonDocument doc;
  bool ok = !deserializeJson(doc, f) && (doc["clear"] | 0) > (doc["blocked"] | 0);
  f.close();
  if (ok) detector.restart({doc["clear"].as<int>(), doc["blocked"].as<int>()});
  return ok;
}

void saveLevels(BeamLevels lv) {
  File f = LittleFS.open("/levels.json", "w");
  if (!f) return;
  JsonDocument doc; doc["clear"] = lv.clear; doc["blocked"] = lv.blocked;
  serializeJson(doc, f); f.close();
}

void sendEvent(const BeamEvent& e) {
  JsonDocument d; d["cmd"] = "beam";
  switch (e.type) {
    case BEAM_BREAK: d["event"] = "break"; d["t"] = e.t; d["level"] = e.level; break;
    case BEAM_RESTORE: d["event"] = "restore"; d["t"] = e.t; break;
    case BEAM_PASS:
      d["event"] = "pass"; d["t0"] = e.t0; d["t1"] = e.t1; d["durationMs"] = e.durationMs;
      d["minLevel"] = e.minLevel; d["meanLevel"] = e.meanLevel; d["maxLevel"] = e.maxLevel; break;
    case BEAM_DRIFT: {
      static const char* K[] = {"low", "high", "noisy", "partial"};
      d["event"] = "drift"; d["kind"] = K[e.drift]; d["estimate"] = e.estimate; d["calibrated"] = e.calibrated; d["sd"] = e.sd; break;
    }
    default: return;   // ready: the heartbeat covers it
  }
  send(d);
}

void sendHeartbeat(double t) {
  JsonDocument d; d["cmd"] = "beam"; d["event"] = "heartbeat"; d["t"] = t;
  d["state"] = calibrated ? detector.state() : "uncalibrated";
  d["level"] = lastLevel; d["calibrated"] = calibrated;
  if (calibrated) {
    d["clearEstimate"] = detector.clearEstimate();
    d["levels"]["clear"] = detector.levels().clear; d["levels"]["blocked"] = detector.levels().blocked;
  }
  send(d);
}

void finishMeasure() {
  measuring = false;
  Stats s = summarize(measureBuf, measureN);
  JsonDocument d; d["cmd"] = "beam"; d["event"] = "measured";
  d["n"] = s.n; d["median"] = s.median; d["mean"] = s.mean; d["sd"] = s.sd; d["min"] = s.min; d["max"] = s.max;
  send(d);
}

Stats statsFrom(JsonVariantConst v) {
  Stats s; s.n = v["n"] | 0; s.median = v["median"] | 0; s.mean = v["mean"] | 0.0; s.sd = v["sd"] | 0.0; s.min = v["min"] | 0; s.max = v["max"] | 0;
  return s;
}

void applyLevels(JsonDocument& in) {
  Derived r = deriveLevels(statsFrom(in["a"]), statsFrom(in["b"]));
  JsonDocument d; d["cmd"] = "beam";
  if (!r.ok) { d["event"] = "calibration_failed"; d["error"] = r.error; send(d); return; }
  detector.restart(r.levels); calibrated = true; saveLevels(r.levels);
  d["event"] = "calibrated"; d["levels"]["clear"] = r.levels.clear; d["levels"]["blocked"] = r.levels.blocked;
  JsonArray w = d["warnings"].to<JsonArray>();
  for (int i = 0; i < r.nWarnings; i++) w.add(r.warnings[i]);
  send(d);
  Serial.printf("# calibrated: clear %d, blocked %d\n", r.levels.clear, r.levels.blocked);
}

void onMessage(uint8_t* payload, size_t len) {
  JsonDocument in;
  if (deserializeJson(in, payload, len)) return;
  const char* type = in["type"] | "";
  if (!strcmp(type, "beam_measure")) { measureN = 0; measuring = true; measureStart = millis(); }
  else if (!strcmp(type, "beam_watch")) watch.start(in["from"] | lastLevel);
  else if (!strcmp(type, "beam_watch_off")) watch.stop();
  else if (!strcmp(type, "beam_levels")) applyLevels(in);
}

void onSocket(WStype_t type, uint8_t* payload, size_t len) {
  if (type == WStype_CONNECTED) {
    connected = true;
    JsonDocument d; d["cmd"] = "hello"; d["role"] = "sensor"; d["version"] = SENSOR_VERSION;
    send(d);
    sendHeartbeat(nowMs());
    Serial.println("# connected to the controller");
  } else if (type == WStype_DISCONNECTED) {
    if (connected) Serial.println("# controller connection lost");
    connected = false; measuring = false; watch.stop();
  } else if (type == WStype_TEXT) onMessage(payload, len);
}

// Find the controller: its mDNS "ws" service, else the fixed CONTROLLER_HOST from secrets.ini.
bool resolveController() {
  int n = MDNS.queryService("ws", "tcp");
  for (int i = 0; i < n; i++) {
    String host = MDNS.answerHostname(i);
    if (host.startsWith(MDNS_HOSTNAME)) { controllerIp = MDNS.answerIP(i); return true; }
  }
  return strlen(CONTROLLER_HOST) && controllerIp.fromString(CONTROLLER_HOST);
}

void setup() {
  Serial.begin(115200);
#ifdef BEAM_SELFTEST
  pinMode(D5, OUTPUT);
#endif
  LittleFS.begin();
  calibrated = loadLevels();
  WiFi.mode(WIFI_STA);
  WiFi.hostname("ztrain-sensor");
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  MDNS.begin("ztrain-sensor");
  Serial.printf("# beam sensor v%s, %s\n", SENSOR_VERSION, calibrated ? "calibrated" : "not calibrated");
}

void loop() {
  MDNS.update();
  if (started) ws.loop();
  if (!started && WiFi.status() == WL_CONNECTED && millis() - lastResolve > RESOLVE_RETRY_MS) {
    lastResolve = millis();
    if (resolveController()) {
      Serial.printf("# controller at %s\n", controllerIp.toString().c_str());
      ws.begin(controllerIp, 81, "/", "arduino");
      ws.onEvent(onSocket);
      ws.setReconnectInterval(2000);
      started = true;
    } else Serial.println("# looking for the controller...");
  }

  unsigned long now = millis();
  if (now - lastSample < SAMPLE_MS) return;
  lastSample = now;
#ifdef BEAM_SELFTEST
  digitalWrite(D5, HIGH);   // bench test: emitter on D5 stays lit
#endif
  uint32_t us = micros();
  double t = nowMs();
  int v = analogRead(A0);
  lastLevel = v;
  Serial.print(v); Serial.print(','); Serial.println(us);

  if (calibrated) {
    BeamEvent ev[4];
    int n = detector.push(t, v, ev, 4);
    for (int i = 0; i < n; i++) sendEvent(ev[i]);
  }
  if (measuring) {
    if (measureN < MEASURE_CAP) measureBuf[measureN++] = v;
    if (now - measureStart >= MEASURE_MS) finishMeasure();
  }
  if (watch.active() && watch.push(v)) {
    watch.stop();
    JsonDocument d; d["cmd"] = "beam"; d["event"] = "changed"; d["t"] = t; d["level"] = v;
    send(d);
  }
  if (now - lastHeartbeat >= HEARTBEAT_MS) { lastHeartbeat = now; sendHeartbeat(t); }
}
