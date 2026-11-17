#!/usr/bin/env python3
# Read A0 values from the sensor Arduino for N seconds and summarise.
import os, sys, time, termios, statistics
port = "/dev/cu.usbmodem1101"
secs = float(sys.argv[1]) if len(sys.argv) > 1 else 3
fd = os.open(port, os.O_RDONLY | os.O_NOCTTY | os.O_NONBLOCK)
a = termios.tcgetattr(fd)
a[0] = 0; a[1] = 0; a[3] = 0
a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
a[4] = a[5] = termios.B115200
termios.tcsetattr(fd, termios.TCSANOW, a)
buf = b""; vals = []
end = time.time() + secs
while time.time() < end:
    try:
        buf += os.read(fd, 4096)
    except BlockingIOError:
        time.sleep(0.01)
os.close(fd)
for line in buf.split(b"\n")[1:-1]:
    try: vals.append(int(line.strip()))
    except ValueError: pass
if vals:
    print(f"n={len(vals)} min={min(vals)} max={max(vals)} mean={statistics.mean(vals):.0f}")
    print("last 12:", vals[-12:])
else:
    print("no data")
