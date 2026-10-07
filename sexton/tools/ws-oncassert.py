#!/usr/bin/env python3
"""#3174 acceptance: does a freshly connected client get its snapshot?

PROTOCOL.md promises a `state` and a `roster` frame on connect. Both are
broadcast only on change, so on a settled channel a client that only
subscribes to the live stream hears nothing at all. This connects, waits, and
reports what actually arrived before anybody moved.

    ssh -L 19099:<bridge-ip>:9099 root@10.0.0.100 -N &
    ./ws-oncassert.py ws://127.0.0.1:19099 5

Exit 0 only if both a state and a roster frame arrive within the window.
Stdlib only; reuses the RFC 6455 reader from ws-capture.py.
"""

import importlib.util
import json
import os
import socket
import sys
import time

_spec = importlib.util.spec_from_file_location(
    "ws_capture", os.path.join(os.path.dirname(os.path.abspath(__file__)), "ws-capture.py")
)
_wc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_wc)

TYPE_STATE = 0x06
TYPE_ROSTER = 0x04


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else "ws://127.0.0.1:19099"
    window = float(sys.argv[2]) if len(sys.argv) > 2 else 5.0

    t0 = time.time()
    sock, rest = _wc.ws_connect(url)
    print(f"handshake ok at t={time.time() - t0:.3f}s -> {url}", flush=True)
    sock.settimeout(0.5)
    reader = _wc.Reader(sock, rest)

    seen = {}
    while time.time() - t0 < window:
        try:
            opcode, payload = reader.next_message()
        except socket.timeout:
            continue
        except ConnectionError:
            break
        if opcode == 0x8:
            print("server closed")
            break
        if opcode != 0x2:
            continue
        msg_type, header, pcm = _wc.parse_frame(payload)
        name = _wc.TYPE_NAMES.get(msg_type, hex(msg_type))
        t = time.time() - t0
        if msg_type not in seen:
            seen[msg_type] = t
        # Audio frames are per-20 ms; log one line, not hundreds.
        if msg_type == 0x01:
            continue
        print(f"  t={t:6.3f}s {name} {json.dumps(header)}", flush=True)
    sock.close()

    print()
    ok = True
    for want, label in ((TYPE_STATE, "state"), (TYPE_ROSTER, "roster")):
        if want in seen:
            print(f"PASS {label} arrived at t={seen[want]:.3f}s")
        else:
            print(f"FAIL no {label} frame in {window:.0f}s")
            ok = False
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
