#include <ESP8266WiFi.h>
#include <ESP8266WebServer.h>
#include <ESP8266mDNS.h>
#include <WebSocketsServer.h>
#include <WebSockets.h>
#include <LittleFS.h>
#include <ArduinoJson.h>

#include "arduino_secrets.h"
#include "Motor.h"

#define VERSION "1.0.0"

// WiFi credentials from arduino_secrets.h
char wifi_ssid[] = WIFI_SSID;
char wifi_pass[] = WIFI_PASS;
char mdns_hostname[] = MDNS_HOSTNAME;
char railroad_name[] = RAILROAD_NAME;

// TB6612FNG pin assignments (Motor A only)
int pwmA = D1;   // GPIO5  - PWMA
int aIn2 = D2;   // GPIO4  - AIN2
int aIn1 = D3;   // GPIO0  - AIN1
int stby = D4;   // GPIO2  - STBY

// State
float currentSpeed = 0.0;
bool currentDirection = true; // true = forward
unsigned long lastMessageTime = 0;
const unsigned long SAFETY_TIMEOUT = 30000; // 30 seconds

// Servers
ESP8266WebServer server(80);
WebSocketsServer socket(81);

// Motor
Motor motor(pwmA, aIn1, aIn2);

void applyMotorState() {
  int pwmValue = (int)(currentSpeed * MAX_PWM);
  if (pwmValue == 0) {
    motor.stop();
  } else if (currentDirection) {
    motor.forward(pwmValue);
  } else {
    motor.reverse(pwmValue);
  }
}

void broadcastStatus() {
  JsonDocument doc;
  doc["type"] = "status";
  doc["name"] = railroad_name;
  doc["speed"] = currentSpeed;
  doc["direction"] = currentDirection;
  doc["connected"] = true;

  String json;
  serializeJson(doc, json);
  socket.broadcastTXT(json);
}

void handleWebSocketMessage(uint8_t num, uint8_t *payload, size_t length) {
  lastMessageTime = millis();

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.print("JSON parse error: ");
    Serial.println(error.c_str());
    return;
  }

  const char* cmd = doc["cmd"];
  if (!cmd) return;

  if (strcmp(cmd, "speed") == 0) {
    float value = doc["value"] | 0.0f;
    currentSpeed = constrain(value, 0.0f, 1.0f);
    applyMotorState();
    broadcastStatus();
  }
  else if (strcmp(cmd, "direction") == 0) {
    currentDirection = doc["value"] | true;
    applyMotorState();
    broadcastStatus();
  }
  else if (strcmp(cmd, "stop") == 0) {
    currentSpeed = 0.0;
    applyMotorState();
    broadcastStatus();
  }
  else if (strcmp(cmd, "ping") == 0) {
    String pong = "{\"type\":\"pong\"}";
    socket.sendTXT(num, pong);
  }
}

void webSocketEvent(uint8_t num, WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_DISCONNECTED:
      Serial.printf("[%u] Disconnected\n", num);
      break;

    case WStype_CONNECTED:
      Serial.printf("[%u] Connected\n", num);
      lastMessageTime = millis();
      {
        JsonDocument doc;
        doc["type"] = "status";
        doc["name"] = railroad_name;
        doc["speed"] = currentSpeed;
        doc["direction"] = currentDirection;
        doc["connected"] = true;

        String json;
        serializeJson(doc, json);
        socket.sendTXT(num, json);
      }
      break;

    case WStype_TEXT:
      handleWebSocketMessage(num, payload, length);
      break;
  }
}

void setup() {
  Serial.begin(115200);
  Serial.printf("\n\nZ-Duino v%s starting...\n", VERSION);

  // Enable STBY pin (always on)
  pinMode(stby, OUTPUT);
  digitalWrite(stby, HIGH);

  // PWM config: 20kHz (above audible range), 0-1000 range
  analogWriteFreq(20000);
  analogWriteRange(1000);

  // Initialize LittleFS
  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed");
  }

  // Connect to WiFi
  WiFi.begin(wifi_ssid, wifi_pass);
  Serial.printf("Connecting to %s", wifi_ssid);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("Connected! IP: ");
  Serial.println(WiFi.localIP());

  // Start mDNS
  if (MDNS.begin(mdns_hostname)) {
    Serial.printf("mDNS: http://%s.local\n", mdns_hostname);
  }

  // HTTP server: serve frontend from LittleFS
  server.on("/", HTTP_GET, []() {
    File f = LittleFS.open("/index.html", "r");
    if (!f) {
      server.send(500, "text/plain", "index.html not found on LittleFS");
      return;
    }
    server.streamFile(f, "text/html");
    f.close();
  });
  server.onNotFound([]() {
    String path = server.uri();
    if (LittleFS.exists(path)) {
      File f = LittleFS.open(path, "r");
      String contentType = "application/octet-stream";
      if (path.endsWith(".html")) contentType = "text/html";
      else if (path.endsWith(".css")) contentType = "text/css";
      else if (path.endsWith(".js")) contentType = "application/javascript";
      else if (path.endsWith(".woff2")) contentType = "font/woff2";
      server.streamFile(f, contentType);
      f.close();
    } else {
      server.send(404, "text/plain", "Not found: " + path);
    }
  });
  server.begin();
  Serial.println("HTTP server started on port 80");

  // WebSocket server
  socket.begin();
  socket.onEvent(webSocketEvent);
  Serial.println("WebSocket server started on port 81");

  lastMessageTime = millis();
}

void loop() {
  server.handleClient();
  socket.loop();
  MDNS.update();

  // Safety timeout: stop motor if no messages received
  if (currentSpeed > 0.0 && (millis() - lastMessageTime > SAFETY_TIMEOUT)) {
    Serial.println("Safety timeout - stopping motor");
    currentSpeed = 0.0;
    applyMotorState();
    broadcastStatus();
  }
}
