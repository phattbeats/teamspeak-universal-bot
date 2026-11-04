import asyncio, sys
sys.argv=['x']
sys.path.insert(0,'/data/watch')
import sender
from aiortc import RTCPeerConnection
from aiortc.rtcrtpsender import RTCRtpSender
async def main():
    sender.enable_h264_high()
    pc=RTCPeerConnection()
    vt=pc.addTransceiver(sender.TestPattern(),direction='sendonly')
    caps=RTCRtpSender.getCapabilities('video').codecs
    order=[c for c in caps if c.mimeType.lower()=='video/h264' and c.parameters.get('packetization-mode')=='1'][:1]+[c for c in caps if c.mimeType.lower()=='video/rtx'][:1]
    vt.setCodecPreferences(order)
    o=await pc.createOffer(); await pc.setLocalDescription(o)
    for l in pc.localDescription.sdp.split('\r\n'):
        if l.startswith(('m=video','a=rtpmap','a=fmtp')): print(l)
    import aiortc.codecs.h264 as h, av
    e=h.H264Encoder(); f=await sender.TestPattern().recv()
    pk,_=e.encode(f, force_keyframe=True)
    print('encoder profile:', e.codec.profile, 'packets', len(pk))
    await pc.close()
asyncio.run(main())
