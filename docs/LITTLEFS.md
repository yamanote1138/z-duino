# LittleFS & Flash Layout

How the ESP8266 filesystem works on the Wemos D1 Mini with the 4M2M flash layout, and how to avoid the pitfalls we found the hard way.

## Flash Partition Layout

The FQBN option `eesz=4M2M` selects `eagle.flash.4m2m.ld`, which defines:

| Symbol | Value | Meaning |
|---|---|---|
| `_FS_start` | `0x40400000` | Filesystem start (memory-mapped) |
| `_FS_end` | `0x405FA000` | Filesystem end (memory-mapped) |
| `_FS_block` | `0x2000` | Block size: **8192 bytes** |
| `_FS_page` | `0x100` | Page size: **256 bytes** |

The physical flash offset is calculated by subtracting the memory map base (`0x40200000`):

```
FS_PHYS_ADDR = 0x40400000 - 0x40200000 = 0x200000
FS_PHYS_SIZE = 0x405FA000 - 0x40400000 = 0x1FA000 = 2,072,576 bytes
```

The runtime block count:

```
block_count = 2,072,576 / 8,192 = 253 (exact — no remainder)
```

## mklittlefs Parameters

The `mklittlefs` tool packs a directory into a LittleFS image. The parameters **must** match the runtime configuration exactly:

```bash
mklittlefs -c <source_dir> -b 8192 -p 256 -s 2072576 <output.bin>
```

| Flag | Value | Source |
|---|---|---|
| `-b` | `8192` | `_FS_block` from linker script |
| `-p` | `256` | `_FS_page` from linker script |
| `-s` | `2072576` | `_FS_end - _FS_start` = `FS_PHYS_SIZE` |

To verify an image after creation:

```bash
mklittlefs -l -b 8192 -p 256 -s 2072576 <image.bin>
```

(The `-l` flag also requires the block/page/size parameters to read the image correctly.)

## Flashing

Flash the LittleFS image to the physical offset `0x200000`:

```bash
esptool --chip esp8266 --port <PORT> --baud 460800 \
  write-flash 0x200000 littlefs.bin
```

To flash firmware and filesystem together (recommended — avoids race conditions):

```bash
esptool --chip esp8266 --port <PORT> --baud 460800 \
  write-flash 0x0 firmware.bin 0x200000 littlefs.bin
```

## The Block Count Trap

LittleFS stores `block_count` in the superblock (the metadata pair in blocks 0 and 1). During mount, the runtime compares the superblock's `block_count` against its own configured value (`FS_PHYS_SIZE / FS_PHYS_BLOCK`). If they don't match, the mount fails.

With `autoFormat` enabled (the default), a failed mount triggers a silent reformat — creating an empty filesystem with the correct block count. The result: the filesystem mounts, the firmware can create and read its own files, but every file packed into the image is gone. There are no errors, no warnings. It just... works, minus your files.

This is what happens if you use the wrong `-s` value with `mklittlefs`. For example, using `-s 2064384` (252 blocks) when the runtime expects 253 blocks. Off by one block. Silent destruction.

### How to verify

Add a temporary flash dump before `LittleFS.begin()` to inspect the raw superblock:

```cpp
uint8_t buf[64];
ESP.flashRead(0x200000, (uint32_t*)buf, 64);
// Byte 28 (little-endian uint32): block_count
// Should match FS_PHYS_SIZE / FS_PHYS_BLOCK
```

Or print the runtime values directly:

```cpp
#include "flash_hal.h"
Serial.printf("FS_PHYS_SIZE=%u FS_PHYS_BLOCK=%u block_count=%u\n",
  (uint32_t)FS_PHYS_SIZE, (uint32_t)FS_PHYS_BLOCK,
  (uint32_t)(FS_PHYS_SIZE / FS_PHYS_BLOCK));
```

## mklittlefs Version Notes

The `mklittlefs` binary bundled with the ESP8266 Arduino core (v0.2.3) bundles its own copy of the LittleFS library. The on-disk format is LittleFS v2.0 (`LFS_DISK_VERSION = 0x00020000`), which is forward-compatible with the runtime's LittleFS v2.5. The version is not the problem — the block count is.

## Other Flash Layouts

If you change the flash size option (e.g. `4M1M`, `4M3M`), the linker script and therefore all the values above will change. Always derive the mklittlefs parameters from the linker script for your selected layout:

```bash
# Find your linker script
arduino-cli compile --show-properties ... | grep flash_ld

# Then check the values
grep '_FS_' <path_to_linker_script>
```

Or just print `FS_PHYS_SIZE` and `FS_PHYS_BLOCK` from the firmware at runtime — the definitive source of truth.
