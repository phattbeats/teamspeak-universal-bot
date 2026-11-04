#!/usr/bin/env python3
# PHA-3289 headless TS6 screen-share *sender* (one process per viewer).
#
# JSON lines on stdin:
#   {"type":"answer","sdp": "..."}
#   {"type":"offer","sdp": "..."}        viewer re-offer, if any
#   {"type":"candidate","candidate":"candidate:...","mid":"0","mLine":0}
#   {"type":"stop"}
# JSON lines on stdout:
#   {"type":"offer","sdp":"..."}         non-trickle: candidates inline
#   {"type":"answer","sdp":"..."}        reply to a viewer re-offer
#   {"type":"log","msg":"..."}
#   {"type":"connected"} / {"type":"result", ...}
import argparse
import asyncio
import fractions
import json
import sys
import time

from aiortc import RTCPeerConnection, RTCSessionDescription, VideoStreamTrack
from aiortc.rtcrtpsender import RTCRtpSender
from aiortc.sdp import candidate_from_sdp
from av import VideoFrame
from PIL import Image, ImageDraw


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def log(msg):
    emit({"type": "log", "msg": str(msg)})


def enable_h264_high():
    """Encode and advertise H264 High (640c1f), the profile TS6 desktop
    streamers send and their viewers decode daily. aiortc hardcodes Baseline."""
    import inspect
    import textwrap
    import aiortc.codecs as codecs
    import aiortc.codecs.h264 as h264mod
    import aiortc.rtcpeerconnection as rpc
    for c in codecs.CODECS["video"]:
        if c.mimeType.lower() == "video/h264":
            c.parameters["profile-level-id"] = "640c1f"
    src = textwrap.dedent(inspect.getsource(h264mod.H264Encoder._encode_frame))
    src = src.replace('self.codec.profile = "Baseline"', 'self.codec.profile = "High"')
    ns = {}
    exec(src, h264mod.__dict__, ns)
    h264mod.H264Encoder._encode_frame = ns["_encode_frame"]
    orig = rpc.is_codec_compatible
    def compat(a, b):
        if a.mimeType.lower() == "video/h264" and b.mimeType.lower() == "video/h264":
            return a.clockRate == b.clockRate and int(a.parameters.get("packetization-mode", "0")) == int(b.parameters.get("packetization-mode", "0"))
        return orig(a, b)
    rpc.is_codec_compatible = compat


def keep_cands(sdp, keep):
    """Drop every a=candidate except host candidates on an allowed address and
    srflx candidates whose raddr is one. A real TS6 streamer sends 3-4
    candidates; aiortc offers one per interface (docker bridges, tailscale,
    IPv6), which is the prime suspect for the desktop crash."""
    if not keep:
        return sdp
    out = []
    for l in sdp.split("\r\n"):
        if l.startswith("a=candidate:"):
            f = l.split()
            addr = f[4] if len(f) > 4 else ""
            raddr = f[f.index("raddr") + 1] if "raddr" in f else ""
            if addr not in keep and raddr not in keep:
                continue
        out.append(l)
    return "\r\n".join(out)


def ts_msid(sdp):
    """TS6 streamers label their track stream 'outgoing_video'; the desktop
    viewer waits ("Waiting to be let in") until it sees a track in that stream."""
    import re
    out = []
    for l in sdp.split("\r\n"):
        if l.startswith("a=msid-semantic"):
            l = "a=msid-semantic: WMS outgoing_video"
        elif l.startswith("a=msid:"):
            parts = l[len("a=msid:"):].split(" ")
            l = "a=msid:outgoing_video " + (parts[1] if len(parts) > 1 else parts[0])
        elif re.match(r"a=ssrc:\d+ msid:", l):
            head, rest = l.split(" msid:", 1)
            parts = rest.split(" ")
            l = head + " msid:outgoing_video " + (parts[1] if len(parts) > 1 else parts[0])
        out.append(l)
    return "\r\n".join(out)


class TestPattern(VideoStreamTrack):
    """Moving colour bars, 1280x720, so a viewer can see it is live."""

    def __init__(self, w=1280, h=720):
        super().__init__()
        self.w, self.h = w, h
        bars = [(255, 255, 255), (255, 255, 0), (0, 255, 255), (0, 255, 0),
                (255, 0, 255), (255, 0, 0), (0, 0, 255), (20, 20, 20)]
        base = Image.new("RGB", (w * 2, h))
        d = ImageDraw.Draw(base)
        bw = w // len(bars)
        for i in range(len(bars) * 2):
            d.rectangle([i * bw, 0, (i + 1) * bw, h], fill=bars[i % len(bars)])
        self.base = base
        self.n = 0

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        self.n += 1
        x = (self.n * 8) % self.w
        img = self.base.crop((x, 0, x + self.w, self.h))
        d = ImageDraw.Draw(img)
        y = (self.n * 6) % (self.h - 80)
        d.rectangle([40, y, 200, y + 80], fill=(0, 0, 0))
        d.text((60, 30), "PLNT %d" % self.n, fill=(0, 0, 0))
        frame = VideoFrame.from_image(img)
        frame.pts, frame.time_base = pts, time_base
        return frame


async def stdin_lines():
    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    while True:
        raw = await reader.readline()
        if not raw:
            return
        line = raw.decode().strip()
        if line:
            yield line


async def run(a):
    if a.codec == "h264high":
        enable_h264_high()
    pc = RTCPeerConnection()
    done = asyncio.Event()
    t0 = time.time()

    vt = pc.addTransceiver(TestPattern(), direction="sendonly")
    caps = RTCRtpSender.getCapabilities("video").codecs
    order = [c for c in caps if c.mimeType.lower() == "video/h264"] + \
            [c for c in caps if c.mimeType.lower() == "video/vp8"] + \
            [c for c in caps if c.mimeType.lower() == "video/rtx"]
    if a.codec == "h264high":
        order = [c for c in caps if c.mimeType.lower() == "video/h264"
                 and c.parameters.get("packetization-mode") == "1"][:1]
        order += [c for c in caps if c.mimeType.lower() == "video/rtx"][:1]
    if a.codec == "vp8":
        order = [c for c in caps if c.mimeType.lower() in ("video/vp8", "video/rtx")]
    vt.setCodecPreferences(order)
    if a.audio_mline:
        # TS6 desktop streamers always carry an audio m-line (inactive when the
        # stream has no audio); mirror that shape.
        pc.addTransceiver("audio", direction="inactive")

    @pc.on("connectionstatechange")
    async def on_cs():
        log("connectionState=%s (+%.1fs)" % (pc.connectionState, time.time() - t0))
        if pc.connectionState == "connected":
            emit({"type": "connected"})
        if pc.connectionState in ("failed", "closed"):
            done.set()

    @pc.on("iceconnectionstatechange")
    async def on_ics():
        log("iceConnectionState=%s" % pc.iceConnectionState)

    offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    emit({"type": "offer", "sdp": keep_cands(ts_msid(pc.localDescription.sdp), a.keep)})
    log("offer sent (%d bytes)" % len(pc.localDescription.sdp))

    async def reader_task():
        async for line in stdin_lines():
            try:
                msg = json.loads(line)
            except Exception:
                continue
            t = msg.get("type")
            try:
                if t == "answer":
                    await pc.setRemoteDescription(RTCSessionDescription(msg["sdp"], "answer"))
                    log("answer applied (%d bytes)" % len(msg["sdp"]))
                elif t == "offer":
                    await pc.setRemoteDescription(RTCSessionDescription(msg["sdp"], "offer"))
                    ans = await pc.createAnswer()
                    await pc.setLocalDescription(ans)
                    emit({"type": "answer", "sdp": pc.localDescription.sdp})
                    log("answered viewer re-offer")
                elif t == "candidate":
                    c = msg.get("candidate", "")
                    if c.startswith("candidate:"):
                        c = c.split(":", 1)[1]
                    cand = candidate_from_sdp(c.split(" generation")[0])
                    cand.sdpMid = msg.get("mid")
                    cand.sdpMLineIndex = msg.get("mLine", 0)
                    await pc.addIceCandidate(cand)
                elif t == "stop":
                    done.set()
                    return
            except Exception as e:
                log("%s failed: %r" % (t, e))
        done.set()

    rt = asyncio.ensure_future(reader_task())
    try:
        await asyncio.wait_for(done.wait(), timeout=a.seconds)
    except asyncio.TimeoutError:
        pass
    stats = {}
    try:
        for s in (await pc.getStats()).values():
            if s.type == "outbound-rtp":
                stats = {"packetsSent": s.packetsSent, "bytesSent": s.bytesSent}
    except Exception:
        pass
    emit({"type": "result", "connectionState": pc.connectionState, **stats})
    rt.cancel()
    await pc.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--sid")
    p.add_argument("--clid")
    p.add_argument("--seconds", type=int, default=120)
    p.add_argument("--codec", default="h264")
    p.add_argument("--audio-mline", action="store_true")
    p.add_argument("--keep", action="append", default=[], help="allowed candidate address (repeatable)")
    asyncio.run(run(p.parse_args()))
