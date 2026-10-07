#!/usr/bin/env python3
"""#3216 (b)/(c) analysis: steady-state duck depth, ramp timing, cross-talk.

The capture tool's built-in summary averages every frame it classified, which
folds the attack/recovery ramps and the pre/post-tone silence into the two
means and understates the depth. This measures the *steady state* instead:
windows placed well inside each ducked and un-ducked region, with the ramps
excluded and measured separately.

    ./analyze-duck.py <wav> [--expect-tones 220,440]
"""
import sys
import wave

import numpy as np

SR = 48000
BLOCK = 960  # 20 ms


def read_wav(path):
    with wave.open(path, "rb") as w:
        n = w.getnframes()
        return np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float64) / 32768.0


def tone_env(x, freq, block=BLOCK):
    """Per-block magnitude of `freq`, Hann-windowed to kill leakage."""
    nb = len(x) // block
    x = x[: nb * block].reshape(nb, block)
    win = np.hanning(block)
    t = np.arange(block) / SR
    ref = np.exp(-2j * np.pi * freq * t) * win
    # 2/sum(win) normalises a full-scale sinusoid to 1.0
    return np.abs(x @ ref) * 2.0 / win.sum()


def db(x):
    return 20.0 * np.log10(np.maximum(x, 1e-12))


def main():
    path = sys.argv[1]
    x = read_wav(path)
    print(f"{path}: {len(x)/SR:.1f}s, peak={np.abs(x).max():.4f}, rms={np.sqrt((x**2).mean()):.5f}")

    e220 = tone_env(x, 220.0)
    e440 = tone_env(x, 440.0)
    e330 = tone_env(x, 330.0)
    t = np.arange(len(e220)) * BLOCK / SR

    print("\n=== tone presence (median over blocks where the signal is live) ===")
    live = np.abs(x[: len(e220) * BLOCK].reshape(-1, BLOCK)).max(axis=1) > 0.001
    for name, e in (("220Hz", e220), ("330Hz", e330), ("440Hz", e440)):
        if live.any():
            print(f"  {name}: median {db(np.median(e[live])):7.2f} dBFS   peak {db(e.max()):7.2f} dBFS")

    # --- voice ON/OFF regions from the 440 Hz envelope -------------------
    on = e440 > (e440.max() * 0.25)
    if not on.any() or on.all():
        print("\nno 440 Hz burst structure — skipping duck analysis")
        return
    edges = np.diff(on.astype(int))
    starts = np.where(edges == 1)[0] + 1
    stops = np.where(edges == -1)[0] + 1
    print(f"\n=== {len(starts)} voice bursts detected ===")

    # Steady-state windows: skip 300 ms after each transition so neither the
    # 50 ms attack nor the 800 ms recovery is inside the measured window.
    GUARD = int(0.3 * SR / BLOCK)
    duck_vals, undk_vals = [], []
    for s, e in zip(starts, stops):
        if e - s > 2 * GUARD:
            duck_vals.append(e220[s + GUARD : e - GUARD])
    for i in range(len(stops) - 1):
        a, b = stops[i], starts[i + 1] if i + 1 < len(starts) else len(e220)
        if b - a > 2 * GUARD:
            undk_vals.append(e220[a + GUARD : b - GUARD])

    if not duck_vals or not undk_vals:
        print("not enough steady-state material")
        return
    d = db(np.median(np.concatenate(duck_vals)))
    u = db(np.median(np.concatenate(undk_vals)))
    print(f"220 Hz steady un-ducked : {u:7.2f} dBFS")
    print(f"220 Hz steady ducked    : {d:7.2f} dBFS")
    print(f"steady-state duck depth : {u - d:7.2f} dB   (duckGain 0.25 = 12.04 dB)")

    # --- ramp timing -----------------------------------------------------
    lin_u = np.median(np.concatenate(undk_vals))
    lin_d = np.median(np.concatenate(duck_vals))
    atk, rec = [], []
    for s in starts:
        seg = e220[s : s + 15]
        hit = np.where(seg <= lin_d * 1.1)[0]
        if len(hit):
            atk.append(hit[0] * BLOCK / SR * 1000)
    for e in stops:
        seg = e220[e : e + 80]
        hit = np.where(seg >= lin_u * 0.9)[0]
        if len(hit):
            rec.append(hit[0] * BLOCK / SR * 1000)
    if atk:
        print(f"attack  to floor  : median {np.median(atk):6.0f} ms  max {max(atk):6.0f} ms  (spec <= 50 ms)")
    if rec:
        print(f"recover to full   : median {np.median(rec):6.0f} ms  max {max(rec):6.0f} ms  (spec ~800 ms)")


main()
