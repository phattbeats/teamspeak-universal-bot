#!/usr/bin/env python3
"""Push tones into a running ts-bridge's WebSocket — the `bridge-test` send
side, in stdlib Python, so the bridge can be exercised from outside the
compose network (over an ssh -L tunnel) without a Rust toolchain.

    ./ws-tone.py ws://127.0.0.1:19098 20 [music_hz] [voice_hz]

Plays a continuous 220 Hz tone into the music lane (0x82) and 2 s bursts of
440 Hz into the voice lane (0x81) every 4 s, i.e. the same pattern
`bridge-test` drives, and prints each transition with a timestamp.

The two frequencies are overridable so a second bridge can be driven with a
different tone at the same time: that is how PHA-3216 (c) checks that two
simultaneous talkers do not cross-label. `voice_hz=0` sends music only.
"""

import base64
import json
import math
import os
import socket
import struct
import sys
import time
from urllib.parse import urlparse

SAMPLE_RATE = 48000
FRAME_SAMPLES = 960
TYPE_VOICE_AUDIO = 0x81
TYPE_MUSIC_AUDIO = 0x82


def ws_connect(url):
    u = urlparse(url)
    sock = socket.create_connection((u.hostname, u.port or 80), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall(
        (
            f"GET {u.path or '/'} HTTP/1.1\r\nHost: {u.hostname}\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ).encode()
    )
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("closed during handshake")
        buf += chunk
    if b"101" not in buf.split(b"\r\n")[0]:
        raise RuntimeError(f"handshake failed: {buf[:200]!r}")
    return sock


def ws_send_binary(sock, payload):
    """Client->server frames must be masked (RFC 6455 §5.3)."""
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x82, 0x80 | n)
    elif n < 1 << 16:
        head = struct.pack("!BBH", 0x82, 0x80 | 126, n)
    else:
        head = struct.pack("!BBQ", 0x82, 0x80 | 127, n)
    mask = os.urandom(4)
    masked = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
    sock.sendall(head + mask + masked)


def frame(msg_type, header, pcm):
    hb = json.dumps(header).encode()
    return bytes([msg_type]) + struct.pack("<I", len(hb)) + hb + pcm


def tone(freq, phase, amplitude=0.5):
    out = bytearray()
    step = 2.0 * math.pi * freq / SAMPLE_RATE
    for _ in range(FRAME_SAMPLES):
        out += struct.pack("<h", int(math.sin(phase) * amplitude * 32767))
        phase += step
        if phase > 2.0 * math.pi:
            phase -= 2.0 * math.pi
    return bytes(out), phase


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:9099"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 20.0
    music_hz = float(sys.argv[3]) if len(sys.argv) > 3 else 220.0
    voice_hz = float(sys.argv[4]) if len(sys.argv) > 4 else 440.0
    sock = ws_connect(url)
    print(
        f"connected to {url}; sending {seconds:.0f}s of tones "
        f"(music {music_hz:.0f} Hz, voice {voice_hz:.0f} Hz)",
        flush=True,
    )

    # Pre-render one cycle of each tone so the send loop stays ahead of the
    # 20 ms clock — Python cannot synthesise 960 samples per frame in time.
    music, voice = [], []
    mp = vp = 0.0
    for _ in range(50):
        f, mp = tone(music_hz, mp)
        music.append(f)
        f, vp = tone(voice_hz, vp)
        voice.append(f)

    frames = int(seconds * 50)
    start = time.time()
    was_on = False
    for i in range(frames):
        target = start + i * 0.02
        delay = target - time.time()
        if delay > 0:
            time.sleep(delay)
        on = voice_hz > 0 and (i % 200) >= 100
        if on != was_on:
            was_on = on
            print(
                f"t={i * 0.02:6.2f}s  {time.strftime('%H:%M:%S')}  voice {voice_hz:.0f} Hz "
                f"{'ON — expect 220 Hz ducked ~-12 dB within 50 ms' if on else 'OFF — expect recovery over 800 ms'}",
                flush=True,
            )
        ws_send_binary(sock, frame(TYPE_MUSIC_AUDIO, {}, music[i % 50]))
        if on:
            ws_send_binary(sock, frame(TYPE_VOICE_AUDIO, {}, voice[i % 50]))
    print("done", flush=True)
    sock.close()


if __name__ == "__main__":
    main()
