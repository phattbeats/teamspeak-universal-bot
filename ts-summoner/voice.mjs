// #4372: the voice kill switch, live, no restart.
//
// Brandon (PHA-3783): "need a way to disable all voice and whisper. needed in
// times where we dont want the bots talking, as well as saving CPU." One
// switch, read by three things:
//   - the file  : /config/.voice-off (stack.mjs tells every gateway account
//                 where it is via voice.offFile; each runtime polls it and
//                 goes text-only while it exists)
//   - whisper   : `supervisorctl stop whisper` drops the workers now;
//                 run-whisper-pool exits 0 on the file, so a `start` with the
//                 file still there stays down too
//   - the cores : boot-time only (SEXTON_NO_AUDIO from UNIVERSAL_VOICE=0);
//                 this switch does not touch them
// `off` and `on` are idempotent and report `changed`, so "Sexton, go quiet"
// twice in a row reads as "already off" rather than a second announcement.
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

export function createVoiceSwitch({
  offFile = '/config/.voice-off',
  program = 'whisper',
  exec,
  log = () => {},
  fs = { existsSync, unlinkSync, writeFileSync },
} = {}) {
  const isOff = () => fs.existsSync(offFile);
  const state = () => (isOff() ? 'off' : 'on');
  const ctl = async (verb) => {
    if (!exec) return `(no supervisorctl: ${verb} ${program} skipped)`;
    try {
      return await exec(['supervisorctl', verb, program]);
    } catch (e) {
      return `supervisorctl ${verb} ${program} failed: ${e.message}`;
    }
  };
  return {
    isOff,
    state,
    async off(by = 'api') {
      const changed = !isOff();
      if (changed) fs.writeFileSync(offFile, `voice off by ${by} at ${new Date().toISOString()}\n`);
      // Stop whisper even when the file was already there: a hand-started
      // pool, or one from before the file, should not outlive the switch.
      const whisper = await ctl('stop');
      log(`voice off by ${by}: ${changed ? 'file written' : 'already off'}; ${whisper}`);
      return { voice: 'off', changed, whisper, by };
    },
    async on(by = 'api') {
      const changed = isOff();
      if (changed) {
        try { fs.unlinkSync(offFile); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      }
      // File first, then start: the pool script exits 0 while the file exists.
      const whisper = await ctl('start');
      log(`voice on by ${by}: ${changed ? 'file removed' : 'already on'}; ${whisper}`);
      return { voice: 'on', changed, whisper, by };
    },
  };
}
