#!/usr/bin/python3
"""PHA-4919: persistent lifecycle log for the cores and the gateway.

A supervisord eventlistener. Appends one JSON line per lifecycle event
(start, stop, exit, fatal, oom) of `core-*` and `gateway` to
/var/sexton-logs/lifecycle/lifecycle-YYYY-MM-DD.jsonl. The volume is a host
bind mount, so entries survive restarts, redeploys and container replacement.
Daily files, 14 kept.

Every stop/exit carries a `cause`:
  deploy      image/deploy.sh recreated the container (it writes the mark)
  test        a deliberate restart: `lifecycle-mark test` first (or docker restart after it)
  supervisor  supervisord was told to stop it (summoner shift, supervisorctl, rewire)
  unknown     nothing asked for it: a crash, an OOM kill, a bare `docker stop`

Exit entries also carry `detail` (exit status or signal, from supervisord's own
log), `oom` (the container cgroup's oom_kill counter moved) and `tail` (the
last 50 log lines, kept in memory from PROCESS_LOG events).
"""
import collections, datetime, json, os, re, signal, sys, time

DIR = os.environ.get('LIFECYCLE_DIR', '/var/sexton-logs/lifecycle')
MARK = os.environ.get('LIFECYCLE_MARK', '/var/sexton-logs/.lifecycle-mark')
SUPLOG = os.environ.get('SUPERVISORD_LOG', '/run/supervisord.log')
KEEP_DAYS = 14
TAIL = 50
MARK_TTL = 180
WATCH = re.compile(r'^(core-.+|gateway)$')

tails = collections.defaultdict(lambda: collections.deque(maxlen=TAIL))
partial = {}
shutting_down = False
running = set()
last_oom = None


def now():
    return datetime.datetime.now(datetime.timezone.utc)


def prune():
    cutoff = (now() - datetime.timedelta(days=KEEP_DAYS)).strftime('%Y-%m-%d')
    for f in os.listdir(DIR):
        m = re.match(r'lifecycle-(\d{4}-\d\d-\d\d)\.jsonl$', f)
        if m and m.group(1) <= cutoff:
            os.remove(os.path.join(DIR, f))


def write(entry):
    t = now()
    entry = {'ts': t.isoformat(timespec='seconds'), **entry}
    os.makedirs(DIR, exist_ok=True)
    path = os.path.join(DIR, 'lifecycle-%s.jsonl' % t.strftime('%Y-%m-%d'))
    new = not os.path.exists(path)
    with open(path, 'a') as fh:
        fh.write(json.dumps(entry) + '\n')
    if new:
        prune()


def read_mark():
    try:
        cause, epoch = open(MARK).read().split()[:2]
        if time.time() - float(epoch) <= MARK_TTL and cause in ('deploy', 'test'):
            return cause
    except Exception:
        pass
    return None


def oom_kills():
    for p in ('/sys/fs/cgroup/memory.events', '/sys/fs/cgroup/memory/memory.oom_control'):
        try:
            for line in open(p):
                k, _, v = line.partition(' ')
                if k in ('oom_kill',):
                    return int(v)
        except Exception:
            continue
    return None


def suplog_detail(name, after_shutdown=False):
    """Last supervisord log line about NAME's exit/stop: 'exit status 1; not expected'.
    after_shutdown: only lines from the SIGTERM supervisord got for the container stop."""
    try:
        with open(SUPLOG, 'rb') as fh:
            fh.seek(0, 2)
            fh.seek(max(0, fh.tell() - 65536))
            lines = fh.read().decode('utf-8', 'replace').splitlines()
    except Exception:
        return None
    if after_shutdown:
        for i in range(len(lines) - 1, -1, -1):
            if 'indicating exit request' in lines[i]:
                lines = lines[i:]
                break
        else:
            return None
    for line in reversed(lines):
        if ('exited: %s ' % name) in line or ('stopped: %s ' % name) in line:
            m = re.search(r'\((.*)\)\s*$', line)
            return m.group(1) if m else line.split(' ', 3)[-1]
    return None


def parse(raw):
    return dict(kv.split(':', 1) for kv in raw.split())


def begin_shutdown():
    global shutting_down
    if shutting_down:
        return
    shutting_down = True
    write({'event': 'supervisor_shutdown', 'cause': read_mark() or 'unknown',
           'detail': 'container/supervisord stopping (SIGTERM to PID 1)'})


def on_sigterm(*_):
    """supervisord stops the listener with everything else and stops sending it
    events once it is STOPPING, so record the cores' and gateway's shutdown here:
    wait (supervisord waits for us) for their exits to reach supervisord's log."""
    begin_shutdown()
    cause = read_mark() or 'unknown'
    pending = set(running)
    deadline = time.time() + 35
    while pending and time.time() < deadline:
        for name in sorted(pending):
            d = suplog_detail(name, True)
            if d:
                pending.discard(name)
                write({'process': name, 'event': 'stop', 'cause': cause, 'detail': d,
                       'oom': False, 'tail': list(tails[name])})
        time.sleep(0.25)
    for name in sorted(pending):
        write({'process': name, 'event': 'stop', 'cause': cause, 'oom': False,
               'detail': 'no stop in supervisord log before the shutdown wait ended',
               'tail': list(tails[name])})
    os._exit(0)


def handle(etype, hdr, data):
    global shutting_down, last_oom
    if etype.startswith('PROCESS_LOG'):
        name = hdr.get('processname', '')
        if not WATCH.match(name):
            return
        buf = partial.get(name, '') + data
        *lines, rest = buf.split('\n')
        partial[name] = rest[-4000:]
        for ln in lines:
            tails[name].append(ln[:500])
        return
    if etype == 'SUPERVISOR_STATE_CHANGE_STOPPING':
        begin_shutdown()
        return
    if not etype.startswith('PROCESS_STATE_'):
        return
    p = parse(data)
    name = p.get('processname', '')
    if not WATCH.match(name):
        return
    state = etype[len('PROCESS_STATE_'):]
    from_state = p.get('from_state', '')
    entry = {'process': name, 'pid': p.get('pid')}
    if state == 'RUNNING':
        running.add(name)
        write({**entry, 'event': 'start', 'cause': read_mark() or 'supervisor'})
        return
    if state not in ('STOPPED', 'EXITED', 'FATAL'):
        return
    running.discard(name)
    kills = oom_kills()
    oom = bool(kills is not None and last_oom is not None and kills > last_oom)
    if kills is not None:
        last_oom = kills
    mark = read_mark()
    if shutting_down:
        cause = mark or 'unknown'
    elif state == 'STOPPED':
        cause = mark or 'supervisor'
    else:
        cause = mark or 'unknown'
    detail = suplog_detail(name)
    if oom:
        cause = cause if cause != 'supervisor' else 'unknown'
    write({**entry, 'event': {'STOPPED': 'stop', 'EXITED': 'exit', 'FATAL': 'fatal'}[state],
           'cause': cause, 'expected': p.get('expected') != '0' if state == 'EXITED' else None,
           'detail': detail, 'oom': oom, 'tail': list(tails[name])})
    tails[name].clear()


def main():
    global last_oom
    last_oom = oom_kills()
    prior = None
    try:
        files = sorted(f for f in os.listdir(DIR) if f.endswith('.jsonl'))
        if files:
            lines = open(os.path.join(DIR, files[-1])).read().splitlines()
            prior = json.loads(lines[-1]) if lines else None
    except Exception:
        pass
    clean = prior is None or prior.get('event') in ('supervisor_shutdown', 'stop', 'exit', 'fatal')
    write({'event': 'container_start', 'cause': read_mark() or 'unknown',
           'detail': 'previous run ended cleanly' if clean else
           'previous run has no shutdown entry: killed (OOM, host reboot, docker kill?)'})
    signal.signal(signal.SIGTERM, on_sigterm)
    out = sys.stdout
    while True:
        out.write('READY\n'); out.flush()
        hdr = parse(sys.stdin.readline())
        if not hdr:
            return
        payload = sys.stdin.read(int(hdr['len']))
        try:
            if hdr['eventname'].startswith('PROCESS_LOG'):
                h, _, body = payload.partition('\n')
                handle(hdr['eventname'], parse(h), body)
            else:
                handle(hdr['eventname'], hdr, payload)
        except Exception as e:  # never let a logging bug stop the listener
            sys.stderr.write('lifecycle-log: %r\n' % (e,)); sys.stderr.flush()
        out.write('RESULT 2\nOK'); out.flush()


if __name__ == '__main__':
    main()
