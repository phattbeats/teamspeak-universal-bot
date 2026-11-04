import socket, struct, time, sys
# PHA-3289 wide sniffer: every UDP STUN/DTLS/RTP packet on the host (any peer),
# plus everything to/from Brandon's PC. Skips TS voice (9987), DNS, mDNS, SSDP.
s = socket.socket(socket.AF_PACKET, socket.SOCK_RAW, socket.ntohs(3))
end = time.time() + int(sys.argv[1]) if len(sys.argv) > 1 else time.time() + 900
PC = "10.0.0.4"
NOISE = {9987, 53, 5353, 1900, 3702, 137, 138, 123, 67, 68, 41641}
while time.time() < end:
    p = s.recv(65535)
    if len(p) < 42 or p[12:14] != b'\x08\x00' or p[23] != 17:
        continue
    ihl = (p[14] & 15) * 4
    src = socket.inet_ntoa(p[26:30]); dst = socket.inet_ntoa(p[30:34])
    sp, dp = struct.unpack('!HH', p[14+ihl:18+ihl])
    if sp in NOISE or dp in NOISE:
        continue
    pl = p[14+ihl+8:]
    if len(pl) >= 20 and pl[4:8] == b'\x21\x12\xa4\x42':
        kind = 'STUN'
    elif pl[:1] and 20 <= pl[0] <= 63:
        kind = 'DTLS'
    elif pl[:1] and 128 <= pl[0] <= 191:
        kind = 'RTP'
    else:
        kind = '?'
    if kind == '?' and PC not in (src, dst):
        continue
    if dst.startswith('239.') or dst.endswith('.255'):
        continue
    print(time.strftime('%H:%M:%S'), src, sp, '->', dst, dp, len(pl), kind, flush=True)
