#!/usr/bin/env python3
# Offline self-test: feed the real captured TS6 offer SDP to viewer.py and
# confirm it emits a valid answer (createAnswer against the live offer).
import json
import re
import subprocess
import sys

raw = open("/data/watch.log").read()
m = re.search(r"notifyrespondjoinstreamrequest .*? offer=(\S+)", raw)
if not m:
    print("NO OFFER IN LOG")
    sys.exit(1)
esc = m.group(1)


def unescape(v):
    o, it = [], iter(v)
    for c in it:
        if c == "\\":
            n = next(it, "")
            o.append({"s": " ", "p": "|", "/": "/", "n": "\n", "r": "\r", "t": "\t"}.get(n, n))
        else:
            o.append(c)
    return "".join(o)


offer = unescape(esc)
proc = subprocess.Popen(
    ["/data/watch/venv/bin/python", "/data/watch/viewer.py",
     "--sid", "selftest", "--outdir", "/data/capture",
     "--first-media-timeout", "2", "--media-seconds", "1", "--audio-seconds", "1"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)
proc.stdin.write(json.dumps({"type": "offer", "sdp": offer}) + "\n")
proc.stdin.flush()
got_answer = False
import time
start = time.time()
while time.time() - start < 20:
    line = proc.stdout.readline()
    if not line:
        break
    try:
        msg = json.loads(line)
    except Exception:
        print("PY:", line.strip())
        continue
    if msg.get("type") == "answer":
        got_answer = True
        sdp = msg["sdp"]
        mids = re.findall(r"m=(\w+) ", sdp)
        codecs = re.findall(r"a=rtpmap:\d+ ([A-Za-z0-9]+)/", sdp)
        ncand = sdp.count("a=candidate:")
        print("ANSWER OK  mlines=%s  codecs=%s  inline_candidates=%d  bytes=%d"
              % (mids, sorted(set(codecs)), ncand, len(sdp)))
    elif msg.get("type") == "result":
        print("RESULT:", json.dumps(msg))
        break
    else:
        print("PY:", json.dumps(msg))
proc.kill()
print("SELFTEST", "PASS" if got_answer else "FAIL")
