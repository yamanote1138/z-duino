# Status LED Wiring — Z-Duino

## Component
- **Standard 4-pin through-hole RGB LED** — 5mm, **common cathode**, diffused lens

## Pin Assignments

| Wemos Pin | GPIO | LED Pin | Channel | Resistor |
|-----------|------|---------|---------|----------|
| D5 | GPIO14 | Red | Red | 220Ω |
| D6 | GPIO12 | Green | Green | 100Ω |
| D7 | GPIO13 | Blue | Blue | 100Ω |
| GND | — | Cathode | Common GND | — |

## Resistor Calculations
- **Red:** (3.3V − 1.8V) / 220Ω = **6.8mA**
- **Green:** (3.3V − 3.0V) / 100Ω = **3mA**
- **Blue:** (3.3V − 3.0V) / 100Ω = **3mA**

## Wiring Diagram

```
                                    Standard 4-pin RGB LED
                                    (facing flat side of lens)
Wemos D1 Mini
┌──────────┐                        longest leg = cathode (GND)
│          │
│       D5 ├───[220Ω]──────────────── Red leg
│          │
│       D6 ├───[100Ω]──────────────── Green leg
│          │
│       D7 ├───[100Ω]──────────────── Blue leg
│          │
│      GND ├────────────────────────── Cathode (longest leg)
│          │
└──────────┘

Logic (common cathode, active HIGH):
  GPIO HIGH → LED ON  (current flows through GPIO → resistor → LED → GND)
  GPIO LOW  → LED OFF
  PWM direct: analogWrite(pin, 0)    = off
              analogWrite(pin, 1000) = full bright
```

## LED Pinout
```
Facing the flat side of the lens, legs pointing down:

  (2nd longest)  (longest)  (2nd shortest)  (shortest)
      Red        Cathode       Green          Blue

Leg lengths:  longest = GND (common cathode)
              second longest = Red
              second shortest = Green
              shortest = Blue
```

### Orientation Check
1. Find the **longest leg** — that's **Cathode (GND)**
2. Immediately left of cathode (when facing the lens): **Red**
3. Immediately right of cathode: **Green**
4. Rightmost (shortest): **Blue**

## Full Updated Pin Map

| Wemos Pin | GPIO | Function |
|-----------|------|----------|
| D1 | GPIO5 | PWMA (motor speed) |
| D2 | GPIO4 | AIN2 (motor H-bridge) |
| D3 | GPIO0 | AIN1 (motor H-bridge) |
| D4 | GPIO2 | STBY (H-bridge enable) |
| **D5** | **GPIO14** | **Status LED — Red** |
| **D6** | **GPIO12** | **Status LED — Green** |
| **D7** | **GPIO13** | **Status LED — Blue** |
| **GND** | **—** | **Status LED — Cathode** |
