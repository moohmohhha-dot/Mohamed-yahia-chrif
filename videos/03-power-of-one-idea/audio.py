"""Builds the soundtrack for the film from timeline.json.

Writes output/mix.wav (music + sound effects + any recorded dialogue), output/lipsync.json
(mouth envelopes measured from the dialogue, used by the renderer), and output/captions.srt.
Dialogue is read from audio/lines/<line id>.(wav|mp3|m4a); missing lines are skipped, and the
renderer then animates those mouths procedurally from the line timing instead.
"""
import json
import math
import subprocess
import wave
from pathlib import Path

import numpy as np

SR = 44100
ROOT = Path(__file__).parent
OUT = ROOT / "output"
OUT.mkdir(exist_ok=True)
TL = json.loads((ROOT / "timeline.json").read_text())
EV = TL["events"]
DUR = TL["duration"]
N = int(DUR * SR)
rng = np.random.default_rng(7)


def t_axis(d):
    return np.arange(int(d * SR)) / SR


def add(buf, start, sig, gain=1.0):
    i = int(start * SR)
    if i >= len(buf) or i + len(sig) <= 0:
        return
    sig = sig[max(0, -i):]
    i = max(i, 0)
    n = min(len(sig), len(buf) - i)
    buf[i:i + n] += sig[:n] * gain


def band(sig, lo, hi):
    """Brick-wall band-pass in the frequency domain (fine for noise textures)."""
    f = np.fft.rfft(sig)
    fr = np.fft.rfftfreq(len(sig), 1 / SR)
    f[(fr < lo) | (fr > hi)] = 0
    return np.fft.irfft(f, len(sig))


def noise(d):
    return rng.standard_normal(int(d * SR))


def env(d, a=0.005, r=None):
    t = t_axis(d)
    e = np.minimum(1, t / a) if a > 0 else np.ones_like(t)
    if r:
        e *= np.exp(-t / r)
    return e


def fades(sig, fi=0.02, fo=0.05):
    n = len(sig)
    a, b = int(fi * SR), int(fo * SR)
    if a:
        sig[:a] *= np.linspace(0, 1, a)
    if b:
        sig[-b:] *= np.linspace(1, 0, b)
    return sig


def midi(n):
    return 440 * 2 ** ((n - 69) / 12)


def smooth(k):
    k = min(1, max(0, k))
    return k * k * (3 - 2 * k)


def x_at(keys, t):
    if t <= keys[0][0]:
        return keys[0][1]
    for (t0, a), (t1, b) in zip(keys, keys[1:]):
        if t <= t1:
            return a + (b - a) * smooth((t - t0) / (t1 - t0))
    return keys[-1][1]


# ---------------- music ----------------
BAR = 2.5  # 96 bpm, 4/4
CHORDS = {
    "Am": [57, 60, 64], "F": [53, 57, 60], "C": [48, 52, 55, 60], "G": [55, 59, 62],
}
PROG = ["Am", "F", "C", "G"] * 2 + ["F", "G", "Am", "Am"] + ["C", "G", "Am", "F"] + ["Am", "F", "C", "G"] + ["C", "G", "Am", "F", "C", "C"]


def tone(freq, d, partials=(1, .5, .25), decay=None, attack=0.01):
    t = t_axis(d)
    s = sum(a * np.sin(2 * np.pi * freq * (i + 1) * t) for i, a in enumerate(partials))
    return s * env(d, attack, decay)


def music():
    pad, pl, bass, drums = (np.zeros(N) for _ in range(4))
    for bar, name in enumerate(PROG):
        start = bar * BAR
        if start >= DUR:
            break
        notes = CHORDS[name]
        last = bar == len(PROG) - 1
        d = BAR * (2.2 if last else 1.15)
        for n in notes:
            for det in (-0.06, 0.06):
                p = tone(midi(n) * 2 ** (det / 12), d, (1, .35, .12), attack=0.5)
                add(pad, start, fades(p, 0.01, 0.6), 0.05)
        sec = start // 10
        # plucked arpeggio from scene 2 on, eighth notes
        if sec >= 1 or bar % 2 == 1:
            arp = notes + [notes[1] + 12, notes[2] + 12]
            for k in range(8):
                n = arp[(k * 3 + bar) % len(arp)] + 12
                add(pl, start + k * BAR / 8, fades(tone(midi(n), 0.6, (1, .3, .1), decay=0.18), 0.002, 0.05), 0.08 if sec < 3 else 0.11)
        # bass on the beat from scene 3
        if sec >= 2:
            for b in range(4):
                add(bass, start + b * BAR / 4, fades(tone(midi(notes[0] - 12), BAR / 4, (1, .4), decay=0.35), 0.005, 0.05), 0.22)
        # drums in scenes 4-6 (half-time in the rain)
        if sec in (3, 5) or (sec == 4 and bar % 2 == 0):
            for b in range(4):
                bt = start + b * BAR / 4
                if b in (0, 2) or sec == 5:
                    t = t_axis(0.35)
                    kick = np.sin(2 * np.pi * (45 * t + 60 * (1 - np.exp(-t * 30)) / 30)) * np.exp(-t * 9)
                    add(drums, bt, kick, 0.45)
                if b in (1, 3) and sec != 4:
                    add(drums, bt, band(noise(0.18), 900, 6000) * env(0.18, 0.001, 0.05), 0.25)
                for h in (0, 0.5):
                    add(drums, bt + h * BAR / 4, band(noise(0.05), 7000, 14000) * env(0.05, 0.001, 0.015), 0.12)
    mix = pad + pl + bass + drums
    # mood: thin and uneasy in the dying garden, fuller as the plan comes together
    t = np.arange(N) / SR
    level = np.interp(t, [0, 9, 20, 30, 40, 50, 54, 58.5, 60], [.55, .6, .7, .85, .8, .95, 1, .9, 0])
    return mix * level


# ---------------- sound effects ----------------
def drip():
    t = t_axis(0.09)
    f = 1500 * np.exp(-t * 18) + 500
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(0.09, 0.001, 0.03)


def whoosh(d=0.45):
    s = band(noise(d), 300, 4000)
    t = t_axis(d)
    return s * np.sin(np.pi * t / d) ** 2


def step():
    return band(noise(0.06), 60, 500) * env(0.06, 0.002, 0.015)


def clank():
    d = 0.5
    s = sum(a * np.sin(2 * np.pi * f * t_axis(d)) for f, a in ((820, 1), (1870, .7), (2960, .5), (4110, .3)))
    return s * env(d, 0.001, 0.08)


def bell(n, d=1.2):
    return tone(midi(n), d, (1, .0, .4, .0, .2), decay=0.35, attack=0.002)


def chime(start_note=84, count=5, gap=0.07):
    out = np.zeros(int((count * gap + 1.3) * SR))
    for i, n in enumerate([0, 4, 7, 12, 16, 19, 24][:count]):
        add(out, i * gap, bell(start_note + n), 0.5)
    return out


def pop():
    t = t_axis(0.12)
    f = 300 + 900 * t / 0.12
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(0.12, 0.002, 0.04)


def chirp():
    t = t_axis(0.12)
    f = 3200 + 1500 * np.sin(np.pi * t / 0.12)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * t / 0.12) ** 2


def boom():
    t = t_axis(1.6)
    return np.sin(2 * np.pi * 55 * t) * np.exp(-t * 2.5) + band(noise(1.6), 30, 200) * np.exp(-t * 4) * 0.6


def sfx():
    out = np.zeros(N)
    t = np.arange(N) / SR
    # scene 1: cicadas in the heat
    cic = band(noise(10), 4000, 8000) * (0.5 + 0.5 * np.sin(2 * np.pi * 38 * t_axis(10)))
    add(out, 0, fades(cic, 1, 2) * np.interp(t_axis(10), [0, 9, 10], [1, 1, 0]), 0.05)
    # leak drips until the fix; loud in the close-up
    for k in range(3):
        for i in range(60):
            at = i * 0.55 - k * 0.18
            if 0 < at < EV["leakFixed"]:
                add(out, at, drip(), 0.5 if 10 <= at < 12.8 else 0.16)
    # transitions
    for at in (9.8, 19.8, 30.05, 49.8):
        add(out, at, whoosh(), 0.35)
    # footsteps for every walk in the timeline
    for keys in TL["moves"].values():
        for i in range(int(DUR * 100)):
            tt = i / 100
            v = abs(x_at(keys, tt + 0.02) - x_at(keys, tt - 0.02)) / 0.04
            if 25 < v < 4000 and (tt * 9 / math.pi) % 1 < 0.01 * 9 / math.pi + 1e-9:
                add(out, tt, step(), 0.35)
    # the repair
    for at in (23.1, 23.55, 24.0, 24.45):
        add(out, at, clank(), 0.18)
    add(out, EV["leakFixed"], chime(), 0.35)
    for c in TL["cards"]:
        add(out, c["start"], bell(93, 0.9), 0.25)
    # delivery: containers pop out of the box
    for at in EV["containersPop"]:
        add(out, at, pop(), 0.4)
        add(out, at + 0.4, chime(88, 3, 0.05), 0.2)
    # building the gutter: ratchet clicks
    bt = EV["buildStart"]
    while bt < EV["buildEnd"]:
        add(out, bt, band(noise(0.03), 2000, 8000) * env(0.03, 0.001, 0.008), 0.25)
        bt += 0.16
    add(out, EV["buildEnd"], chime(79, 4), 0.3)
    # storm: thunder, rain, gutter trickle
    th = band(noise(4), 20, 300) * env(4, 0.05, 1.1) + band(noise(4), 200, 3000) * env(4, 0.002, 0.08)
    add(out, EV["rainStart"] - 0.3, th, 0.9)
    rd = EV["rainEnd"] - EV["rainStart"] + 1
    rain = band(noise(rd), 800, 9000)
    add(out, EV["rainStart"], fades(rain, 0.8, 1.0), 0.08)
    trickle = band(noise(rd), 300, 1400) * (0.6 + 0.4 * np.sin(2 * np.pi * 3.1 * t_axis(rd)) * np.sin(2 * np.pi * 0.7 * t_axis(rd)))
    add(out, EV["rainStart"] + 0.6, fades(trickle, 1.5, 1.0), 0.06)
    # the garden comes back: rising bells, birds
    for i in range(8):
        add(out, EV["bloomStart"] + i * 0.4, bell(76 + [0, 2, 4, 7, 9, 12, 14, 16][i], 1.4), 0.18)
    for i in range(14):
        add(out, 51 + i * 0.55 + (i % 3) * 0.08, chirp(), 0.12)
    # title hits
    for k, at in enumerate((EV["titleStart"], EV["titleStart"] + 1.2, EV["titleStart"] + 2.4)):
        add(out, at, boom(), 0.35)
        add(out, at, chime(84 + k * 2, 4, 0.04), 0.2)
    return out


# ---------------- dialogue ----------------
def load_line(lid):
    for ext in ("wav", "mp3", "m4a"):
        p = ROOT / "audio" / "lines" / f"{lid}.{ext}"
        if p.exists():
            raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(p), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
                                 check=True, capture_output=True).stdout
            return np.frombuffer(raw, dtype=np.float32).astype(np.float64)
    return None


def dialogue():
    voice = np.zeros(N)
    lips = {}
    for line in TL["lines"]:
        sig = load_line(line["id"])
        if sig is None:
            continue
        add(voice, line["start"], sig, 1.0)
        hop = SR // TL["fps"]
        rms = np.array([np.sqrt(np.mean(sig[i:i + hop] ** 2)) for i in range(0, len(sig), hop)])
        top = np.percentile(rms, 95) or 1
        lips[line["id"]] = [round(float(min(1, max(0, (v / top - 0.08) / 0.92))), 3) for v in rms]
        print(f"  voice {line['id']}: {len(sig) / SR:.2f}s (slot {line['end'] - line['start']:.2f}s)")
    return voice, lips


def srt():
    def ts(s):
        ms = int(round(s * 1000))
        return f"{ms // 3600000:02d}:{ms // 60000 % 60:02d}:{ms // 1000 % 60:02d},{ms % 1000:03d}"
    rows = []
    for i, line in enumerate(TL["lines"], 1):
        who = TL["characters"][line["who"]]["name"]
        rows.append(f"{i}\n{ts(line['start'])} --> {ts(line['end'] + 0.3)}\n{who}: {line['text']}\n")
    (OUT / "captions.srt").write_text("\n".join(rows))


def main():
    m, fx = music(), sfx()
    voice, lips = dialogue()
    # duck the music under dialogue
    if voice.any():
        e = np.abs(voice)
        k = int(0.15 * SR)
        e = np.convolve(e, np.ones(k) / k, mode="same")
        m *= 1 - 0.6 * np.clip(e / (e.max() or 1) * 4, 0, 1)
    mix = m * 0.9 + fx + voice
    mix /= max(1e-9, np.abs(mix).max()) / 0.89
    # gentle stereo width: music slightly delayed on the right
    d = int(0.012 * SR)
    right = mix.copy()
    right[d:] = 0.8 * mix[d:] + 0.2 * mix[:-d]
    stereo = np.stack([mix, right], axis=1)
    with wave.open(str(OUT / "mix.wav"), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(stereo, -1, 1) * 32767).astype(np.int16).tobytes())
    (OUT / "lipsync.json").write_text(json.dumps(lips))
    srt()
    print(f"mix.wav written; {len(lips)} recorded dialogue lines")


if __name__ == "__main__":
    main()
