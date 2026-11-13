# Building Lights (design proposal)

Individually controlled lights for four Z-scale buildings, using four addressable RGB pixels on a single data pin. Every building is detachable. Status: design agreed, no firmware or UI changes yet.

## Approach

- One WS2812B-2020 pixel per building, daisy-chained on **D8 (GPIO15)**.
- Powered from the D1 Mini's **5V pin (USB)**, never from the 12V track supply. The only link to the track side is the existing shared ground.
- Each hop between buildings is a 3-wire cable (5V, data, GND) with a plug at each end.
- No extra boards. The main building keeps its status LED (D5/D6/D7), which already lights its windows, so it gets no pixel.

## Layout

```
 [B1] -6"- [B2] -10"- [B3] -10"- [MAIN] -18"- [B4]
                                 D1 Mini

 Chain order:  MAIN --> B4 --> B3 --> B2 --> B1
 Hop cable:        18"    28"    10"     6"
 Pixel index:             0      1      2     3
```

The controller is in the middle of the row, so data goes out to B4 first and returns toward B1. The 28" hop passes the main building.

## Detachable buildings

Parts: JST-SYP 2.5 mm 3-pin male/female wire-to-wire pigtails (on hand).

- Each building has two short pigtails that drop through the baseboard: **IN (male)** and **OUT (female)**. The D1 Mini's OUT pigtail is female too.
- Each hop cable is **male at the upstream end, female at the downstream end**.
- Pin order on every connector: **1 = 5V (red), 2 = data (green), 3 = GND (black)**.
- 8 mated pairs in total (1 at the D1 Mini, 2 per building except B1 which has 1). Keep 1 spare pair.

To remove a building mid-chain, unplug its IN and OUT pigtails. The hop cables on either side then plug straight into each other (female end meets male start) and the rest of the lights keep working. Removing B1 (last in chain) needs nothing.

Build notes: pigtail leads are thicker (about 22 AWG) than the hop wire. Solder, heat-shrink every joint and stagger the three joints. IN and OUT pigtails share the VDD and GND pads on each pixel, so choose a breakout with room for two wires per pad. Continuity-test each cable before connecting a pixel.

## Schematic

```
 D1 Mini                                  +5V rail
 5V ---|>|---+----------+-----[plug]--[plug]--VDD--+--[plug]--[plug]--VDD--+-- ...
        1N4001 |          |                          |
              ===220uF    |
               |          |
 D8 ---[330R]--|----------+-----[plug]--[plug]--DIN #0 DOUT --[plug]--[plug]--DIN #1 DOUT -- ...
               |                                  GND
 GND ----------+-----------------[plug]--[plug]----+-- ...
                                  GND rail
```

Each plug carries 5V, data and GND. Each pixel's DOUT feeds the next pixel's DIN through the plugs. The last DOUT is unconnected.

- The diode drops USB 5V (about 4.9V) to about 4.3V so the pixels' logic threshold (about 3.0V) sits below the 3.3V data signal.
- The 330R resistor protects the first pixel's input. The 220uF capacitor absorbs the power-on surge.

## Pin budget

| Pin | Use |
|---|---|
| D1, D2, D3, D4 | PWMA, AIN2, AIN1, STBY |
| D5, D6, D7 | Status LED R, G, B (unchanged) |
| **D8** | **Building light data (new)** |
| D0, A0 | Free (D0 has no PWM, A0 is input-only) |

## Parts

| Qty | Part | Notes |
|---|---|---|
| 6 | WS2812B-2020 RGB pixel, pre-mounted on a tiny breakout or pre-wired | 4 needed, 2 spares. SK6812 Mini-E is an easier-to-solder alternative. |
| 9 pairs | JST-SYP 2.5 mm 3-pin male/female | On hand. 8 needed plus 1 spare. |
| 1 | 1N4001 diode | 1N4148 also works |
| 1 | 330 ohm resistor, 1/4 W | |
| 1 | 220uF electrolytic capacitor, 10V+ | |
| 3 spools | 28-30 AWG silicone wire, red / black / green, about 10 ft each | Hops need about 5 ft of each colour (62" per conductor) |
| 1 | Heat-shrink assortment, 1-2 mm | About 70 joints |
| 1 | Aluminium foil tape or matte black paint | Stops light bleeding through the walls |
| 1 | Tracing paper or frosted tape | Window diffuser |
| 4 | 100nF ceramic capacitor (optional) | Skip if the breakouts include one |

## Software plan

Protocol additions (building id 0-3, B1 = 0 ... B4 = 3):

```
{"cmd": "light", "id": 2, "on": true, "r": 255, "g": 150, "b": 50, "brightness": 0.6}
{"cmd": "lights_off"}
status gains: "lights": [{"on": true, "r": 255, "g": 150, "b": 50, "brightness": 0.6}, ...]
```

- `platformio.ini`: add Adafruit NeoPixel; define `LIGHT_PIN` and `LIGHT_COUNT`.
- `lib/LightLogic/` (new): state, brightness cap (default 25%), building-to-pixel map, colour scaling. Native tests.
- `lib/Command/`: parse `light` and `lights_off`. Native tests.
- `firmware/z-duino/Lights.h/.cpp` (new): NeoPixel wrapper, pushes a frame only on change.
- `firmware/z-duino/z-duino.ino`: clear pixels first in `setup()`, dispatch commands, add `lights` to status.
- Frontend: `LightsPanel.vue`, `useTrainController.ts`, `mock-server.ts`, tests.
- Docs: `HARDWARE.md`, `PROTOCOL.md`.

## Risks

- **D8 must be low at boot:** the D1 Mini pulls it down, and the pixel input idles low.
- **Pixel flash at power-up:** firmware clears pixels first in `setup()`.
- **Interrupts vs software PWM:** pixel updates block interrupts about 30us per pixel. Update only on change. Fallback: RX (GPIO3) with NeoPixelBus DMA.
- **USB current:** four pixels at the 25% cap draw about 60mA at most.
- **Intermittent plug contact:** seat plugs fully, reseat upstream plugs first if a pixel flickers.
- **Wrong pin order:** same order on every connector, continuity-test every cable.
- **Light bleed:** line the building interiors.
- **Wrong chain order:** one remap constant in firmware.

## Open decisions

Decided: no pixel in the main building (the status LED stays); every building detachable.

1. Persist light state across reboots via a debounced LittleFS write.
2. Default brightness cap (25% is a starting guess).
3. Effects (flicker, TV glow, day/night fade) in a later pass.
