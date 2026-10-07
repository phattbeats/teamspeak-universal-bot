//! Two-lane mixer: voice (model speech) + music, with auto-ducking.
//!
//! Owned by the TS connection task and driven by a 20 ms tick. WebSocket
//! handlers push samples in from other tasks, so it is wrapped in a mutex by
//! the caller (contention is negligible: pushes are occasional, the tick is
//! the only frequent reader).

use std::collections::VecDeque;

/// 48 kHz * 20 ms.
pub const FRAME_SAMPLES: usize = 960;

/// Duck-down completes within 50 ms (spec) = 2 frames of 20 ms.
const ATTACK_FRAMES: f32 = 2.0;
/// Recovery completes within 800 ms (spec) = 40 frames of 20 ms.
const RECOVER_FRAMES: f32 = 40.0;

pub struct Mixer {
    voice: VecDeque<i16>,
    music: VecDeque<i16>,
    /// User-set multiplier from `music_gain` (0..1), applied before ducking.
    music_gain: f32,
    /// Current duck envelope value, 1.0 = no ducking, `duck_gain` = fully ducked.
    duck_current: f32,
    duck_target_floor: f32,
    /// Set by `speaker_start`/`speaker_stop` bookkeeping in the TS task —
    /// ducking also engages while any human is talking, not just while the
    /// voice lane has queued audio.
    human_speaking: bool,
}

pub struct MixedFrame {
    pub samples: [i16; FRAME_SAMPLES],
    /// True if the music lane contributed audible (non-silent) samples to
    /// this frame — used to pick OpusMusic vs OpusVoice.
    pub music_active: bool,
}

impl Mixer {
    pub fn new(duck_gain: f32) -> Self {
        Self {
            voice: VecDeque::new(),
            music: VecDeque::new(),
            music_gain: 1.0,
            duck_current: 1.0,
            duck_target_floor: duck_gain.clamp(0.0, 1.0),
            human_speaking: false,
        }
    }

    pub fn push_voice(&mut self, samples: &[i16]) {
        self.voice.extend(samples.iter().copied());
    }

    pub fn push_music(&mut self, samples: &[i16]) {
        self.music.extend(samples.iter().copied());
    }

    pub fn set_music_gain(&mut self, gain: f32) {
        self.music_gain = gain.clamp(0.0, 1.0);
    }

    pub fn clear_voice(&mut self) {
        self.voice.clear();
    }

    pub fn set_human_speaking(&mut self, speaking: bool) {
        self.human_speaking = speaking;
    }

    /// Queued voice samples, queued music samples, current duck envelope.
    /// Telemetry only — the send tick logs this so a silent channel can be
    /// diagnosed without a debugger (#3216).
    pub fn lanes(&self) -> (usize, usize, f32) {
        (self.voice.len(), self.music.len(), self.duck_current)
    }

    /// Pop one 20 ms frame, advance the duck envelope, and mix.
    pub fn next_frame(&mut self) -> MixedFrame {
        let voice_has_audio = !self.voice.is_empty();
        let should_duck = voice_has_audio || self.human_speaking;
        let target = if should_duck { self.duck_target_floor } else { 1.0 };

        // Linear ramp over the full 1.0..floor span. Deriving the step from the
        // *remaining* distance instead would make this an exponential approach
        // that only ever halves the gap, so it would never actually reach the
        // floor in 50 ms or full gain in 800 ms the way the spec requires.
        let span = 1.0 - self.duck_target_floor;
        if target < self.duck_current {
            self.duck_current = (self.duck_current - span / ATTACK_FRAMES).max(target);
        } else {
            self.duck_current = (self.duck_current + span / RECOVER_FRAMES).min(target);
        }

        let mut samples = [0i16; FRAME_SAMPLES];
        let mut music_active = false;
        for out in samples.iter_mut() {
            let v = self.voice.pop_front().unwrap_or(0) as f32;
            let m_raw = self.music.pop_front().unwrap_or(0) as f32;
            let m = m_raw * self.music_gain * self.duck_current;
            if m_raw.abs() > 0.0 {
                music_active = true;
            }
            *out = (v + m).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
        MixedFrame { samples, music_active }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ducks_within_two_frames_and_recovers_within_forty() {
        let mut mixer = Mixer::new(0.25);
        mixer.push_music(&vec![10_000i16; FRAME_SAMPLES * 100]);
        // No voice yet: full gain.
        let f0 = mixer.next_frame();
        assert!(f0.music_active);
        assert_eq!(f0.samples[0], 10_000);

        // Voice starts: duck engages, must reach the floor within 2 frames.
        mixer.push_voice(&vec![0i16; FRAME_SAMPLES * 10]);
        let _f1 = mixer.next_frame();
        let f2 = mixer.next_frame();
        // f2 is the 2nd frame after ducking started; envelope should be at
        // (or very near) the floor by now.
        let expected_floor_sample = (10_000f32 * 0.25) as i16;
        assert!((f2.samples[0] - expected_floor_sample).abs() <= 1);

        // Voice stops: recovery is gradual, not instant...
        mixer.clear_voice();
        mixer.set_human_speaking(false);
        let f3 = mixer.next_frame();
        assert!(f3.samples[0] < 10_000, "recovery should not be instant");

        // ...and completes within the 800 ms / 40-frame window. f3 above was
        // the 1st recovery frame, so 39 more get us back to full gain.
        for _ in 0..38 {
            mixer.next_frame();
        }
        // Tolerance is for f32 accumulation across 40 steps, not for slack in
        // the timing: 9_990/10_000 is within 0.1% of full gain.
        let recovered = mixer.next_frame().samples[0];
        assert!(
            recovered >= 9_990,
            "should be back to full gain 40 frames (800 ms) after voice stops, got {recovered}"
        );
    }

    #[test]
    fn human_speaking_ducks_music_without_any_queued_voice() {
        let mut mixer = Mixer::new(0.25);
        mixer.push_music(&vec![10_000i16; FRAME_SAMPLES * 10]);
        mixer.set_human_speaking(true);
        mixer.next_frame();
        let f = mixer.next_frame();
        assert!((f.samples[0] - 2_500).abs() <= 1, "got {}", f.samples[0]);
    }

    #[test]
    fn clear_voice_drops_queued_voice_for_barge_in() {
        let mut mixer = Mixer::new(0.25);
        mixer.push_voice(&vec![5_000i16; FRAME_SAMPLES * 10]);
        mixer.clear_voice();
        assert_eq!(mixer.next_frame().samples[0], 0);
    }
}
