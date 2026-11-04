import socket,struct,time,sys
s=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.ntohs(3))
end=time.time()+1500
PC="10.0.0.4"
while time.time()<end:
    p=s.recv(65535)
    if len(p)<42 or p[12:14]!=b'\x08\x00' or p[23]!=17: continue
    ihl=(p[14]&15)*4
    src=socket.inet_ntoa(p[26:30]);dst=socket.inet_ntoa(p[30:34])
    if PC not in (src,dst): continue
    sp,dp=struct.unpack('!HH',p[14+ihl:18+ihl])
    if 9987 in (sp,dp) or 53 in (sp,dp) or 5353 in (sp,dp) or 1900 in (sp,dp): continue
    pl=p[14+ihl+8:]
    kind='STUN' if len(pl)>=20 and pl[4:8]==b'\x21\x12\xa4\x42' else ('DTLS' if pl[:1] and 20<=pl[0]<=63 else ('RTP' if pl[:1] and 128<=pl[0]<=191 else '?'))
    print(time.strftime('%H:%M:%S'),src,sp,'->',dst,dp,len(pl),kind,flush=True)
