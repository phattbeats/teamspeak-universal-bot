#!/usr/bin/env python3
# PHA-3289: replay the last captured TS6 offer + ICE candidates through viewer.py
# (no live stream needed) to see whether aiortc sends STUN checks at all.
import json, re, subprocess, sys, time

raw = open("/data/watch.log").read()
offers = list(re.finditer(r"notifyrespondjoinstreamrequest clid=(\d+) id=(\S+) msg\S* decision=1 offer=(\S+)", raw))
if not offers:
    print("NO OFFER"); sys.exit(1)
m = offers[-1]
clid, sid, esc = m.group(1), m.group(2), m.group(3)

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
cands = []
for cm in re.finditer(r"notifystreamsignaling clid=%s id=%s json=(\S+)" % (clid, re.escape(sid)), raw):
    j = json.loads(unescape(cm.group(1)))
    if j.get("cmd") == "iceCandidate":
        cands.append(j["args"])
print("sid=%s clid=%s candidates=%d" % (sid, clid, len(cands)), flush=True)

proc = subprocess.Popen(
    ["/data/watch/venv/bin/python", "/data/watch/viewer.py",
     "--sid", "replay", "--outdir", "/data/capture",
     "--first-media-timeout", str(int(sys.argv[1]) if len(sys.argv) > 1 else 15),
     "--media-seconds", "1", "--audio-seconds", "1"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
)
proc.stdin.write(json.dumps({"type": "offer", "sdp": offer}) + "\n"); proc.stdin.flush()
sent = False
start = time.time()
while time.time() - start < 40:
    line = proc.stdout.readline()
    if not line:
        break
    try:
        msg = json.loads(line)
    except Exception:
        print("RAW:", line.strip(), flush=True); continue
    t = msg.get("type")
    if t == "answer":
        print("ANSWER %d bytes" % len(msg["sdp"]), flush=True)
        for c in cands:
            proc.stdin.write(json.dumps({"type": "candidate", "candidate": c["sdp"], "mid": c["mid"], "mLine": c["mLine"]}) + "\n")
        proc.stdin.flush(); sent = True
    elif t == "result":
        print("RESULT", json.dumps(msg), flush=True); break
    else:
        print("PY", msg.get("msg", msg), flush=True)
proc.kill()
