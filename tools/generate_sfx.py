"""Generate original prototype SFX with Python's standard library, without samples."""

import math
import random
import struct
import wave
from pathlib import Path

RATE = 22050
OUT = Path(__file__).resolve().parents[1] / "audio" / "sfx"


def render(name, duration, tones=(), noise=0.0):
    rng = random.Random(name)
    samples = []
    filtered = 0.0
    for i in range(round(RATE * duration)):
        t = i / RATE
        progress = t / duration
        envelope = min(t / 0.008, 1.0) * (1.0 - progress) ** 2
        value = 0.0
        for start, end, gain, delay in tones:
            local = t - delay
            if local < 0:
                continue
            span = duration - delay
            phase = math.tau * (start * local + (end - start) * local * local / (2 * span))
            value += math.sin(phase) * gain * math.exp(-local * 3.0 / span)
        filtered = filtered * 0.65 + rng.uniform(-1.0, 1.0) * 0.35
        value = (value + filtered * noise) * envelope
        samples.append(value)
    peak = max(max(abs(v) for v in samples), 0.001)
    pcm = b"".join(struct.pack("<h", round(v / peak * 0.65 * 32767)) for v in samples)
    with wave.open(str(OUT / f"{name}.wav"), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(RATE)
        output.writeframes(pcm)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    specs = {
        "jump": (0.17, [(300, 650, 0.55, 0)], 0.25),
        "air_jump": (0.18, [(550, 980, 0.5, 0), (820, 1200, 0.15, 0.025)], 0.15),
        "flip": (0.12, [(520, 260, 0.35, 0)], 0.5),
        "land": (0.10, [(170, 100, 0.4, 0)], 0.4),
        "dash": (0.24, [(240, 100, 0.3, 0)], 1.0),
        "pickup": (0.23, [(1080, 1080, 0.5, 0), (1620, 1620, 0.25, 0.045)], 0),
        "skill": (0.38, [(260, 780, 0.45, 0), (520, 1040, 0.2, 0.035)], 0.7),
        "strike": (0.24, [(180, 70, 0.4, 0)], 1.1),
        "hit": (0.19, [(160, 80, 0.6, 0)], 1.0),
        "guard": (0.15, [(880, 700, 0.4, 0), (1400, 1100, 0.25, 0)], 0.15),
        "kill": (0.36, [(180, 55, 0.5, 0), (360, 90, 0.18, 0.025)], 0.8),
        "warning_top": (0.30, [(830, 830, 0.55, 0), (1245, 1245, 0.2, 0.10)], 0),
        "warning_bottom": (0.30, [(415, 415, 0.55, 0), (622, 622, 0.2, 0.10)], 0),
        "volley": (0.23, [(350, 140, 0.4, 0)], 0.9),
        "boss_enter": (0.65, [(110, 165, 0.5, 0), (220, 330, 0.2, 0.12)], 0.35),
        "sweep": (0.43, [(220, 80, 0.45, 0)], 1.0),
        "weakpoint": (0.32, [(660, 660, 0.45, 0), (990, 990, 0.3, 0.08)], 0),
        "boss_kill": (0.85, [(140, 40, 0.5, 0), (280, 80, 0.3, 0.05)], 1.0),
        "ready": (0.25, [(880, 880, 0.35, 0), (1320, 1320, 0.25, 0.07)], 0),
        "clear": (0.85, [(440, 440, 0.4, 0), (550, 550, 0.4, 0.14), (660, 660, 0.45, 0.28), (880, 880, 0.3, 0.42)], 0),
        "fail": (0.65, [(330, 110, 0.45, 0), (220, 75, 0.3, 0.13)], 0.15),
    }
    for name, (duration, tones, noise) in specs.items():
        render(name, duration, tones, noise)
    print(f"Generated {len(specs)} SFX in {OUT}")


if __name__ == "__main__":
    main()
