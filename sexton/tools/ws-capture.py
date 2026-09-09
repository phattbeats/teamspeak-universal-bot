#!/usr/bin/env python3
"""PHA-3216 acceptance capture: record what the channel actually hears.

Connects to a *listener* Sexton's audio bridge WebSocket (a second Sexton
instance sitting in the same TS6 channel as the bridge under test), records every
`speaker_audio` frame it emits, and measures the 220 Hz music lane and the
440 Hz voice lane out of the decoded PCM.

Because it reads the listener bridge's per-speaker output, everything it
measures has been through the full path: mixer -> Opus encode -> TS6 server
-> Opus decode. That is what criterion (a)/(b) mean by "from the capture".

    ssh -L 9099:<listener-bridge-ip>:9099 root@10.0.0.100 -N &
    ./ws-capture.py ws://127.0.0.1:9099 40 /tmp/capture

Writes <out>.wav per speaker, <out>.frames.jsonl (every out frame with a
receive timestamp), and prints the duck analysis.

Stdlib only: implements just enough RFC 6455 to read binary frames. numpy is
used for the analysis if present; without it the capture still runs.
"""

import base64
import json
import os
import socket
import struct
import sys
import time
import wave
from urllib.parse import urlparse

FRAME_SAMPLES = 960  # 20 ms at 48 kHz
SAMPLE_RATE = 48000

TYPE_NAMES = {
    0x01: "speaker_audio",
    0x02: "speaker_start",
    0x03: "speaker_stop",
    0x04: "roster",
    0x05: "text_message",
    0x06: "state",
}


def ws_connect(url):
    u = urlparse(url)
    host, port = u.hostname, u.port or 80
    sock = socket.create_connection((host, port), timeout=10)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f"GET {u.path or '/'} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\n"
        "Sec-WebSocket-Version: 13\r\n\r\n"
    )
    sock.sendall(req.encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("server closed during handshake")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    if b"101" not in head.split(b"\r\n")[0]:
        raise RuntimeError(f"handshake failed: {head!r}")
    return sock, rest


class Reader:
    """Minimal RFC 6455 frame reader (server->client frames are unmasked)."""

    def __init__(self, sock, initial=b""):
        self.sock = sock
        self.buf = bytearray(initial)

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk

    def _take(self, n):
        self._need(n)
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def next_message(self):
        """Return (opcode, payload) for one (possibly fragmented) message."""
        opcode_out, payload = None, b""
        while True:
            b0, b1 = self._take(2)
            fin, opcode = b0 & 0x80, b0 & 0x0F
            masked, length = b1 & 0x80, b1 & 0x7F
            if length == 126:
                (length,) = struct.unpack(">H", self._take(2))
            elif length == 127:
                (length,) = struct.unpack(">Q", self._take(8))
            mask = self._take(4) if masked else None
            data = self._take(length)
            if mask:
                data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
            if opcode == 0x9:  # ping -> pong, masked as a client must
                self.sock.sendall(pong(data))
                continue
            if opcode == 0x8:
                return 0x8, b""
            if opcode != 0x0:
                opcode_out = opcode
            payload += data
            if fin:
                return opcode_out, payload


def pong(data):
    mask = os.urandom(4)
    masked = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
    return b"\x8a" + bytes([0x80 | len(data)]) + mask + masked


def parse_frame(payload):
    """type, header dict, pcm bytes — the bridge's 1+4+JSON+payload framing."""
    if len(payload) < 5:
        return None, {}, b""
    msg_type = payload[0]
    (header_len,) = struct.unpack("<I", payload[1:5])
    end = min(5 + header_len, len(payload))
    try:
        header = json.loads(payload[5:end])
    except Exception:
        header = {}
    return msg_type, header, payload[end:]


def goertzel(samples, freq):
    """Magnitude of `freq` in `samples`, normalised to full scale."""
    n = len(samples)
    if n == 0:
        return 0.0
    k = 2.0 * 3.141592653589793 * freq / SAMPLE_RATE
    import math

    coeff = 2.0 * math.cos(k)
    s1 = s2 = 0.0
    for x in samples:
        s0 = x + coeff * s1 - s2
        s2, s1 = s1, s0
    power = s1 * s1 + s2 * s2 - coeff * s1 * s2
    return (2.0 * math.sqrt(max(power, 0.0)) / n) / 32768.0


def db(x):
    import math

    return 20.0 * math.log10(x) if x > 1e-9 else -180.0


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:9099"
    seconds = float(sys.argv[2]) if len(sys.argv) > 2 else 40.0
    out_base = sys.argv[3] if len(sys.argv) > 3 else "/tmp/capture"

    sock, rest = ws_connect(url)
    sock.settimeout(2.0)
    reader = Reader(sock, rest)
    print(f"connected to {url}; capturing {seconds:.0f}s", flush=True)

    speakers = {}  # clientId -> {"nickname":.., "pcm":bytearray, "frames":[..]}
    events = []
    start = time.time()
    log = open(f"{out_base}.frames.jsonl", "w")
    while time.time() - start < seconds:
        try:
            opcode, payload = reader.next_message()
        except socket.timeout:
            continue
        except ConnectionError:
            break
        if opcode == 0x8:
            break
        if opcode != 0x2:
            continue
        t = time.time() - start
        msg_type, header, pcm = parse_frame(payload)
        rec = {"t": round(t, 4), "type": TYPE_NAMES.get(msg_type, hex(msg_type)), "header": header}
        if msg_type == 0x01:
            cid = header.get("clientId")
            sp = speakers.setdefault(cid, {"nickname": header.get("nickname"), "pcm": bytearray(), "frames": []})
            sp["nickname"] = header.get("nickname") or sp["nickname"]
            sp["pcm"] += pcm
            sp["frames"].append((t, header.get("seq"), len(pcm)))
            rec["bytes"] = len(pcm)
        else:
            events.append(rec)
            print(f"  t={t:6.2f}s {rec['type']} {json.dumps(header)}", flush=True)
        log.write(json.dumps(rec) + "\n")
    log.close()
    sock.close()

    if not speakers:
        print("\nNO speaker_audio frames received — nothing was talking in-channel.")
        return 1

    print("\n=== speakers ===")
    for cid, sp in speakers.items():
        samples = len(sp["pcm"]) // 2
        print(
            f"clientId={cid} nickname={sp['nickname']!r} frames={len(sp['frames'])} "
            f"samples={samples} ({samples / SAMPLE_RATE:.1f}s)"
        )
        path = f"{out_base}.speaker{cid}.wav"
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(bytes(sp["pcm"]))
        print(f"  wrote {path}")

    # --- (a)/(b) analysis on the loudest speaker -------------------------
    cid, sp = max(speakers.items(), key=lambda kv: len(kv[1]["pcm"]))
    pcm = struct.unpack(f"<{len(sp['pcm']) // 2}h", bytes(sp["pcm"][: (len(sp["pcm"]) // 2) * 2]))
    print(f"\n=== envelope for clientId={cid} ({sp['nickname']!r}) ===")

    rows = []
    for i in range(0, len(pcm) - FRAME_SAMPLES, FRAME_SAMPLES):
        block = pcm[i : i + FRAME_SAMPLES]
        rows.append(
            (
                i / SAMPLE_RATE,
                db(goertzel(block, 220.0)),
                db(goertzel(block, 440.0)),
            )
        )

    # Voice ON where the 440 Hz component is within 20 dB of its own peak.
    peak440 = max(r[2] for r in rows)
    on = [r[2] > peak440 - 20.0 for r in rows]
    quiet = [r[1] for r, o in zip(rows, on) if not o]
    loud = [r[1] for r, o in zip(rows, on) if o]
    print(f"220 Hz un-ducked (voice OFF): {sum(quiet) / len(quiet):+.2f} dBFS  over {len(quiet)} frames" if quiet else "no voice-OFF frames")
    print(f"220 Hz ducked   (voice ON):  {sum(loud) / len(loud):+.2f} dBFS  over {len(loud)} frames" if loud else "no voice-ON frames")
    if quiet and loud:
        print(f"measured duck depth: {sum(quiet) / len(quiet) - sum(loud) / len(loud):.2f} dB   (expected ~12.04 dB)")

    # Transitions: how fast the duck reaches the floor and how long recovery takes.
    for i in range(1, len(on)):
        if on[i] and not on[i - 1]:
            print(f"\nvoice ON at t={rows[i][0]:.2f}s — 220 Hz over the next 200 ms:")
            for r in rows[i - 1 : i + 10]:
                print(f"  t={r[0]:6.2f}s  220Hz={r[1]:+7.2f} dBFS  440Hz={r[2]:+7.2f} dBFS")
        if not on[i] and on[i - 1]:
            print(f"\nvoice OFF at t={rows[i][0]:.2f}s — 220 Hz recovery over the next 1.0 s:")
            for r in rows[i - 1 : i + 50 : 5]:
                print(f"  t={r[0]:6.2f}s  220Hz={r[1]:+7.2f} dBFS  440Hz={r[2]:+7.2f} dBFS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
