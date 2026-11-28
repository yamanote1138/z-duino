#!/usr/bin/env python3
"""Pull real train sounds out of two sibling projects into local/sounds (git-ignored; TRAIN_LOCAL moves it), under the file names the sound pack manifests (packs/jr-east/pack.json) refer to.

  ../jr-esu-sound-profiles/src/*.ssdx (was ../e235-sounds/data)   BVE sound archive (a zip; filenames are Shift-JIS)
  ../eki-pi/sounds/            station melodies and JP/EN announcements

Usage: python3 -I import-sounds.py [name ...]     (no names = everything defined below)
Standard library only. The sounds belong to their original authors; they stay on this machine and are not committed.
"""
import io, os, sys, wave, zipfile, glob, shutil, array, math

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.environ.get("TRAIN_LOCAL") or os.path.join(HERE, "local"), "sounds")
SSDX = glob.glob(os.path.join(HERE, "..", "..", "..", "jr-esu-sound-profiles", "src", "*.ssdx")) or glob.glob(os.path.join(HERE, "..", "..", "..", "e235-sounds", "data", "*.ssdx"))
EKI = os.path.join(HERE, "..", "..", "..", "eki-pi", "sounds")
os.makedirs(OUT, exist_ok=True)

def archive():
    if not SSDX:
        sys.exit("no .ssdx found in ../e235-sounds/data")
    z = zipfile.ZipFile(SSDX[0]); files = {}
    for i in z.infolist():
        try: name = i.filename.encode("cp437").decode("shift_jis")
        except Exception: name = i.filename
        files[os.path.basename(name)] = z.read(i)
    return files

def wav_of(data):
    w = wave.open(io.BytesIO(data))
    return w.getparams(), w.readframes(w.getnframes())

def write_wav(name, params, frames):
    w = wave.open(os.path.join(OUT, name + ".wav"), "wb"); w.setparams(params); w.writeframes(frames); w.close()
    print(f"  wrote {name}.wav  ({len(frames) / (params.sampwidth * params.nchannels * params.framerate):.2f} s)")

def horn(files, loops=4):
    """JR East electric horn (BVE E233 'typhon'): the attack, the sustain looped, then the decay."""
    p, a = wav_of(files["E233_typ_in.wav"]); _, b = wav_of(files["E233_typ_loop.wav"]); _, c = wav_of(files["E233_typ_out.wav"])
    write_wav("horn", p, a + b * loops + c)

def samples(frames):
    a = array.array("h"); a.frombytes(frames); return a

def clip(frames, rate, t0, t1, fade_in=0.0, fade_out=0.0):
    x = samples(frames); a, b = int(t0 * rate), min(int(t1 * rate), len(x)); seg = array.array("h", x[a:b]); n = len(seg)
    for i in range(min(int(fade_in * rate), n)): seg[i] = int(seg[i] * i / (fade_in * rate))
    for i in range(min(int(fade_out * rate), n)): seg[n - 1 - i] = int(seg[n - 1 - i] * i / (fade_out * rate))
    return seg.tobytes()

def seamless(frames, rate, xf=0.4):
    """Make a loop that continues from its end back into its start by cross-fading the two ends."""
    x = samples(frames); n, X = len(x), int(xf * rate); out = array.array("h", x[: n - X])
    for i in range(X):
        u = i / X; out[i] = int(x[i] * u + x[n - X + i] * (1 - u))
    return out.tobytes()

def accel(files):
    """E235 SiC-VVVF start-up: the falling chirp and the climb (first 7.5 s of the real recording)."""
    p, d = wav_of(files["E235_SiCVVVF_\u52a0\u901f.wav"]); write_wav("accel_e235", p, clip(d, p.framerate, 0, 7.5, 0.02, 0.8))

def cruise(files):
    """E235 steady running whine: the level stretch (33 to 36.9 s) of the acceleration recording, cross-faded into a loop.
    The earlier cut started at 30 s, where the pitch is still climbing, so every repeat sounded like another acceleration."""
    p, d = wav_of(files["E235_SiCVVVF_\u52a0\u901f.wav"]); write_wav("cruise_e235", p, seamless(clip(d, p.framerate, 33.0, 36.9), p.framerate, 0.8) * 9)   # ~28 s so a show never has to restart it

def decel(files):
    """E235 SiC-VVVF slowing: the last seven seconds of the deceleration recording, ending in the rising chirp."""
    p, d = wav_of(files["E235_SiCVVVF_\u6e1b\u901f.wav"]); write_wav("decel_e235", p, clip(d, p.framerate, 14.8, 21.8, 0.05, 0.3))

def copy_of(archive_name, out_name):
    def build(files):
        p, d = wav_of(files[archive_name]); write_wav(out_name, p, d)
    return build

def railloop(files):
    """Rail-joint clatter while moving: the BVE loop sample repeated to about 29 s."""
    p, d = wav_of(files["rjoint_C76_LOOP.wav"]); write_wav("railloop", p, d * 17)

def smooth(x):
    x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)

def doppler(files, dur=2.4, t_pass=0.45, hi=1.14, lo=0.88):
    """The horn rushing past: pitch high on the way in, dropping through the pass, and a swell in loudness at the pass."""
    p, a = wav_of(files["E233_typ_in.wav"]); _, b = wav_of(files["E233_typ_loop.wav"]); _, c = wav_of(files["E233_typ_out.wav"])
    src = [(v - 128) / 128.0 for v in a + b * 6 + c]            # these samples are 8-bit unsigned
    rate = p.framerate; n = int(dur * rate); out = array.array("h"); pos = 0.0
    for i in range(n):
        t = i / rate
        r = lo + (hi - lo) * (1 - smooth((t - t_pass + 0.15) / 0.3))
        k = int(pos)
        if k >= len(src) - 1: break
        v = src[k] + (src[k + 1] - src[k]) * (pos - k); pos += r
        width = 0.18 if t < t_pass else 0.75
        g = 0.22 + 0.78 * math.exp(-(((t - t_pass) / width) ** 2))
        fade = min(1.0, (n - i) / (0.12 * rate))
        out.append(int(max(-1.0, min(1.0, v * g * fade * 1.4)) * 32000))
    params = (1, 2, rate, len(out), "NONE", "not compressed")
    write_wav("horn_doppler", wave._wave_params(*params), out.tobytes())

def eki(files):
    """Station melodies and a JP/EN announcement pair from ../eki-pi, copied as they are (afplay plays mp3 and wav)."""
    for src, dst in [("eki-melo/seseragi.mp3", "melody_seseragi.mp3"), ("eki-melo/water_crown.mp3", "melody_water_crown.mp3"),
                     ("eki-melo/tetsuwan_atom_a.mp3", "melody_atom.mp3"),
                     ("announcements/announcement_01_jp.wav", "announce1_jp.wav"), ("announcements/announcement_01_en.wav", "announce1_en.wav")]:
        shutil.copy(os.path.join(EKI, src), os.path.join(OUT, dst)); print(f"  copied {dst}")

def runloops(files):
    """Running-sound candidates built from samples made to loop in BVE, so no cross-fade is needed:
    the E259 static-inverter hum and the MH3130 compressor loop, each repeated to about 28 s."""
    p, d = wav_of(files["E259SIV_loop.wav"]); n = max(1, math.ceil(28 * p.framerate * p.sampwidth / len(d))); write_wav("run_siv", p, d * n)
    p, d = wav_of(files["MH3130-C1600F_loop.wav"]); n = max(1, math.ceil(28 * p.framerate * p.sampwidth / len(d))); write_wav("run_mh", p, d * n)

def pick(files, *parts):
    """The archive name that contains every part (the names mix English and Japanese, so match on pieces)."""
    for n in files:
        if all(x in n for x in parts): return n
    raise KeyError(parts)

def horn_pass(files):
    """The horn for the pass, about 2.3 s: the attack, five repeats of the sustain, then the decay."""
    p, a = wav_of(files["E233_typ_in.wav"]); _, b = wav_of(files["E233_typ_loop.wav"]); _, c = wav_of(files["E233_typ_out.wav"]); write_wav("horn_pass", p, a + b * 5 + c)

def brakes(files):
    """Brake sounds: a short squeal, the loosening ('yurume') and the release."""
    for out, parts in [("brake_squeal", ("E259_B", "\u77ed")), ("brake_yurume", ("E235_B", "\u30e6\u30eb\u30e1")),
                       ("brake_release", ("E235_B", "\u7de9\u89e3")),
                       ("brake_departure", ("E235_", "\u767a\u8eca"))]:
        p, d = wav_of(files[pick(files, *parts)]); write_wav(out, p, d)

def flanges(files):
    """The twelve curve flange squeals, as flange_1 ... flange_12."""
    for i in range(1, 13):
        p, d = wav_of(files[f"cflange_{i}.wav"]); write_wav(f"flange_{i}", p, d)

BUILDERS = {"horn": horn, "accel": accel, "cruise": cruise, "decel": decel,
            "buzzer": copy_of("EF210_Buzzer3.wav", "buzzer_ef210"),
            "railjoint": copy_of("rjoint_C76_X1.wav", "railjoint"),
            "railloop": railloop, "doppler": doppler, "eki": eki, "runloops": runloops,
            "horn_pass": horn_pass, "brakes": brakes, "flanges": flanges}

if __name__ == "__main__":
    want = sys.argv[1:] or list(BUILDERS)
    files = archive()
    for n in want:
        if n not in BUILDERS: sys.exit(f"unknown sound {n}; choices: {', '.join(BUILDERS)}")
        BUILDERS[n](files)
