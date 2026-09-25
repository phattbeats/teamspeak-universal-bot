//! The audio/voice lane: per-speaker Opus decode in, mixed Opus encode out,
//! and the roster/state events the Sexton's WS bridge clients subscribe to.
//!
//! **History.** This is PHA-3342's port of what used to be
//! `ts-bridge/src/ts_client.rs` — the file that, before PHA-3341, owned a
//! *second* `tsclientlib::Connection` under the `Sexton-Bridge` identity so
//! the audio sidecar could speak TeamSpeak independently of the text
//! Sexton. PHA-3341 collapsed that into one `Connection` fronted by a
//! Unix-socket IPC (`bridge-proto`) between the Sexton and a still-separate
//! `ts-bridge` container. PHA-3342 finishes the job Brandon asked for —
//! "everything running off of one docker container / one bot account" —
//! by folding the audio sidecar process itself into this binary: the logic
//! below now runs against the *same* `Connection` the text lane
//! (`main.rs`) already owns, driven by the same `con.events()` stream and
//! a 20 ms tick merged into `main.rs`'s `tokio::select!` loop. Nothing
//! about the receive/send algorithm changed — only whose connection it
//! runs on.
//!
//! Carries the TS6 patches noted in the PHA-3099 epic findings, same as
//! the text lane: tsclientlib's own connect handshake does not request the
//! channel list or subscribe to all channels against TS6 the way it did
//! against TS3 (finding #6) — `main.rs`'s `run_once` already sends both
//! explicitly, once, for the one shared connection.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::{broadcast, Mutex as TokioMutex};
use tracing::{debug, warn};

use tsclientlib::{ChannelId, ClientId, Connection};
use tsproto_packets::packets::{AudioData, CodecType, InAudioBuf, OutAudio};

use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};

use bridge_proto::events::{BridgeEvent, RosterEntry};
use bridge_proto::{Snapshot, StateSnapshot};

use crate::mixer::{Mixer, FRAME_SAMPLES};

/// tsclientlib decodes every incoming stream to interleaved **stereo**
/// (`audio::CHANNEL_NUM`), and `AudioQueue::get_next_data`/`fill_buffer` take a
/// length in interleaved values, not per-channel samples. So one 20 ms frame is
/// `FRAME_SAMPLES * TS_DECODE_CHANNELS` values, which we downmix to the mono
/// 48 kHz the WebSocket protocol promises.
const TS_DECODE_CHANNELS: usize = 2;

/// How many consecutive all-zero 20 ms frames we keep transmitting before
/// emitting the stop-talking marker. 10 frames = 200 ms, enough to ride over
/// the gaps between words without holding the channel open indefinitely.
const SILENCE_HANGOVER_FRAMES: u32 = 10;

/// Everything the 20 ms tick and the inbound `StreamItem::Audio` handler
/// need that must survive across ticks/packets but must NOT survive a
/// reconnect (fresh per `run_once` attempt, same as the old ts_client.rs's
/// locals — a stale `AudioHandler`/encoder from a previous TS session is
/// not meaningfully resumable).
pub struct AudioState {
    voice_encoder: Encoder,
    music_encoder: Encoder,
    audio: tsclientlib::audio::AudioHandler,
    known_talkers: HashSet<u16>,
    speaker_seq: HashMap<u16, u32>,
    /// Set by `BridgeCommand::Mute`. Distinct from the TS mute flag — this
    /// only stops us transmitting, same contract as the old bridge's mute.
    muted: bool,
    /// Whether we are mid-transmission, so we know when to emit the
    /// stop-talking marker.
    sending: bool,
    /// Tags the stop-talking marker with the codec the stream was
    /// actually using when it was open.
    last_codec: CodecType,
    silent_frames: u32,
    tick_count: u64,
    // Receive-path telemetry, logged at 1 Hz next to the send tick.
    dropped_packets: u64,
    recv_frames: u64,
    recv_peak: u16,
    /// Scratch mix buffer for `fill_buffer_with_proc`: one 20 ms interleaved
    /// stereo frame. We only want the per-speaker tap, not the mix, but the
    /// call needs a correctly sized buffer to know how much to pull.
    mix: Vec<f32>,
}

impl AudioState {
    pub fn new() -> Result<Self> {
        let voice_encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
            .map_err(|e| anyhow!("voice opus encoder: {e:?}"))?;
        let mut music_encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Audio)
            .map_err(|e| anyhow!("music opus encoder: {e:?}"))?;
        music_encoder
            .set_bitrate(Bitrate::BitsPerSecond(64_000))
            .map_err(|e| anyhow!("music opus bitrate: {e:?}"))?;
        Ok(Self {
            voice_encoder,
            music_encoder,
            audio: tsclientlib::audio::AudioHandler::default(),
            known_talkers: HashSet::new(),
            speaker_seq: HashMap::new(),
            muted: false,
            sending: false,
            last_codec: CodecType::OpusVoice,
            silent_frames: 0,
            tick_count: 0,
            dropped_packets: 0,
            recv_frames: 0,
            recv_peak: 0,
            mix: vec![0f32; FRAME_SAMPLES * TS_DECODE_CHANNELS],
        })
    }

    pub fn set_muted(&mut self, muted: bool) {
        self.muted = muted;
    }

    /// Handle one inbound `StreamItem::Audio` packet: queue it into the
    /// per-speaker jitter buffer. Draining happens on the 20 ms tick, not
    /// here — tsclientlib's jitter buffer measures time by how many
    /// samples it has handed out, so it has to be pulled on a steady
    /// clock. Draining once per arriving packet backed the queue up to
    /// `QueueFull` and produced digital silence in PHA-3216.
    pub async fn on_audio_packet(
        &mut self,
        mixer: &Arc<TokioMutex<Mixer>>,
        event_tx: &broadcast::Sender<BridgeEvent>,
        audio_pkt: InAudioBuf,
    ) {
        let from_raw: u16 = match audio_pkt.data().data() {
            AudioData::S2C { from, .. } => *from,
            _ => return,
        };
        let from_id = ClientId(from_raw);

        match self.audio.handle_packet(from_id, audio_pkt) {
            Ok(_) => {
                if self.known_talkers.insert(from_raw) {
                    let _ = event_tx.send(BridgeEvent::SpeakerStart { client_id: from_raw });
                    mixer.lock().await.set_human_speaking(true);
                }
            }
            Err(e) => {
                // Never silent: a queue that rejects packets is
                // indistinguishable, on the wire, from a silent channel.
                self.dropped_packets = self.dropped_packets.wrapping_add(1);
                if self.dropped_packets % 50 == 1 {
                    warn!(
                        "dropped inbound audio from client {from_raw}: {e} ({} dropped so far)",
                        self.dropped_packets
                    );
                }
            }
        }
    }

    /// The 20 ms tick: drain one frame per speaker out of the jitter
    /// buffer (emitting `SpeakerAudio`/`SpeakerStop`), then pop one mixed
    /// frame from the `Mixer` and either encode+send it or emit the
    /// stop-talking marker.
    pub async fn on_tick(
        &mut self,
        con: &mut Connection,
        mixer: &Arc<TokioMutex<Mixer>>,
        event_tx: &broadcast::Sender<BridgeEvent>,
    ) {
        // --- receive: pull exactly one 20 ms frame per speaker -----------
        //
        // `fill_buffer_with_proc` is the upstream-blessed per-speaker tap:
        // it hands each queue's own samples to the closure before mixing
        // them into `mix`, and returns the talkers that ended — either
        // end-of-stream or too many consecutive packet losses, which is
        // how a dead queue gets retired instead of emitting concealment
        // silence forever.
        self.mix.fill(0.0);
        let mut drained: Vec<(u16, Vec<f32>)> = Vec::new();
        let ended = self.audio.fill_buffer_with_proc(&mut self.mix, |id: &ClientId, samples: &[f32]| {
            if !samples.is_empty() {
                drained.push((id.0, samples.to_vec()));
            }
        });

        if !drained.is_empty() {
            // Name each queue from its own client: draining is per-speaker,
            // so tagging frames with whoever's packet happened to wake us
            // up would mislabel audio as soon as two people talk at once.
            let nicknames: HashMap<u16, String> = {
                let state = con.get_state().ok();
                drained
                    .iter()
                    .map(|(cid, _)| {
                        let name = state
                            .and_then(|s| s.clients.get(&ClientId(*cid)).map(|c| c.name.clone()))
                            .unwrap_or_else(|| format!("client-{cid}"));
                        (*cid, name)
                    })
                    .collect()
            };

            for (cid, samples) in drained {
                let pcm: Vec<i16> = samples
                    .chunks_exact(TS_DECODE_CHANNELS)
                    .map(|f| {
                        let mono = 0.5 * (f[0] + f[1]);
                        (mono.clamp(-1.0, 1.0) * i16::MAX as f32) as i16
                    })
                    .collect();
                self.recv_peak = self.recv_peak.max(pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0));
                self.recv_frames = self.recv_frames.wrapping_add(1);
                let seq = self.speaker_seq.entry(cid).or_insert(0);
                *seq += 1;
                let _ = event_tx.send(BridgeEvent::SpeakerAudio {
                    client_id: cid,
                    nickname: nicknames.get(&cid).cloned().unwrap_or_else(|| format!("client-{cid}")),
                    seq: *seq,
                    pcm,
                });
            }
        }

        for id in ended {
            if self.known_talkers.remove(&id.0) {
                let _ = event_tx.send(BridgeEvent::SpeakerStop { client_id: id.0 });
            }
        }
        if self.known_talkers.is_empty() {
            mixer.lock().await.set_human_speaking(false);
        }

        // --- send ----------------------------------------------------------
        if self.muted {
            // Going muted mid-utterance still owes the channel a
            // stop-talking marker, or we leave every listener holding an
            // open stream from us.
            if self.sending {
                self.send_stop_talking(con);
            }
            return;
        }

        let (frame, lanes) = {
            let mut m = mixer.lock().await;
            let frame = m.next_frame();
            (frame, m.lanes())
        };
        let peak = frame.samples.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);

        // 1 Hz send-path telemetry: enough to tell "nothing is reaching the
        // mixer" from "the mixer is full but the channel is silent"
        // without attaching a debugger. Logged before the send decision so
        // the tick keeps reporting while we are deliberately transmitting
        // nothing.
        self.tick_count = self.tick_count.wrapping_add(1);
        if self.tick_count % 50 == 0 {
            debug!(
                "send tick: voice_queued={} music_queued={} duck={:.2} music_active={} peak={} sending={} | recv: talkers={} frames/s={} peak={} dropped={}",
                lanes.0,
                lanes.1,
                lanes.2,
                frame.music_active,
                peak,
                self.sending,
                self.known_talkers.len(),
                self.recv_frames,
                self.recv_peak,
                self.dropped_packets
            );
            self.recv_frames = 0;
            self.recv_peak = 0;
        }

        // Stop transmitting when we have nothing to say, instead of
        // streaming Opus-encoded silence forever (PHA-3216). The hangover
        // keeps the stream open across short gaps — without it, pauses
        // between words in a TTS utterance (or a quiet passage in music)
        // would each close and reopen the stream, spamming every listener
        // with speaker_start/speaker_stop and making them re-open a jitter
        // buffer mid-sentence.
        if peak > 0 {
            self.silent_frames = 0;
        } else {
            self.silent_frames = self.silent_frames.saturating_add(1);
            // The hangover only holds an *already open* stream open. If we
            // are not mid-utterance there is nothing to ride over, and
            // sending silence here would open a stream just to close it
            // 200 ms later — which is what made an idle bridge emit a
            // spurious speaker_start/speaker_stop pair on connect.
            if !self.sending {
                return;
            }
        }
        if peak == 0 && self.silent_frames >= SILENCE_HANGOVER_FRAMES {
            if self.sending {
                self.send_stop_talking(con);
            }
            return;
        }

        let encoder = if frame.music_active { &mut self.music_encoder } else { &mut self.voice_encoder };
        let codec = if frame.music_active { CodecType::OpusMusic } else { CodecType::OpusVoice };
        let mut out_buf = [0u8; 1275];
        match encoder.encode(&frame.samples, &mut out_buf) {
            Ok(len) => {
                let pkt = OutAudio::new(&AudioData::C2S { id: 0, codec, data: &out_buf[..len] });
                if let Err(e) = con.send_audio(pkt) {
                    warn!("send_audio failed: {e}");
                }
                self.sending = true;
                self.last_codec = codec;
            }
            Err(e) => warn!("opus encode failed: {e:?}"),
        }
    }

    fn send_stop_talking(&mut self, con: &mut Connection) {
        let stop = OutAudio::new(&AudioData::C2S { id: 0, codec: self.last_codec, data: &[] });
        if let Err(e) = con.send_audio(stop) {
            warn!("send stop-talking failed: {e}");
        }
        self.sending = false;
    }

    /// Cleanup owed on every disconnect (temporary or final): nobody can be
    /// mid-sentence across a disconnect and their real `SpeakerStop` is
    /// never coming, and the mixer's duck flag must not latch on forever
    /// (PHA-3216 / PHA-3174 standing requirement — the mixer outlives the
    /// connection attempt).
    pub async fn on_disconnect(&mut self, mixer: &Arc<TokioMutex<Mixer>>, event_tx: &broadcast::Sender<BridgeEvent>) {
        for cid in self.known_talkers.drain() {
            let _ = event_tx.send(BridgeEvent::SpeakerStop { client_id: cid });
        }
        mixer.lock().await.set_human_speaking(false);
    }
}

/// Resolve a `Join`/startup channel spec (numeric id or exact-ish name) the
/// same way both the CLI's initial join and the WS bridge's `join` command
/// do.
pub fn resolve_channel_id(state: &tsclientlib::data::Connection, spec: &str) -> Option<ChannelId> {
    if let Ok(n) = spec.parse::<u64>() {
        if state.channels.contains_key(&ChannelId(n)) {
            return Some(ChannelId(n));
        }
    }
    state
        .channels
        .iter()
        .find(|(_, ch)| ch.name.eq_ignore_ascii_case(spec))
        .map(|(id, _)| *id)
}

fn build_roster(state: &tsclientlib::data::Connection, channel: ChannelId) -> Vec<RosterEntry> {
    state
        .clients
        .values()
        .filter(|c| c.channel == channel)
        .map(|c| RosterEntry {
            client_id: c.id.0,
            nickname: c.name.clone(),
            muted: c.input_muted || c.output_muted,
            away: c.away_message.is_some(),
            server_groups: resolve_server_group_names(state, c),
        })
        .collect()
}

/// Server group names for one client (PHA-3786). Carried on the wire so the
/// TS plugin, which owns `tools.moderation.allowGroups`, can gate
/// moderation tools without a second round trip.
fn resolve_server_group_names(
    state: &tsclientlib::data::Connection,
    client: &tsclientlib::data::Client,
) -> Vec<String> {
    client
        .server_groups
        .iter()
        .filter_map(|id| state.server_groups.get(id))
        .map(|g| g.name.clone())
        .collect()
}

fn roster_signature(roster: &[RosterEntry]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut sorted: Vec<&RosterEntry> = roster.iter().collect();
    sorted.sort_by_key(|r| r.client_id);
    for r in sorted {
        r.client_id.hash(&mut hasher);
        r.nickname.hash(&mut hasher);
        r.muted.hash(&mut hasher);
        r.away.hash(&mut hasher);
    }
    hasher.finish()
}

/// Publish `state`/`roster` to bridge subscribers if either changed since
/// the last call. Both are broadcast only on change, so the stream stays
/// quiet on a settled channel — but `snapshot` is updated unconditionally,
/// so a WS client connecting between two changes still gets the current
/// picture (`PROTOCOL.md`'s on-connect promise).
pub async fn emit_state_and_roster(
    con: &mut Connection,
    event_tx: &broadcast::Sender<BridgeEvent>,
    snapshot: &Arc<TokioMutex<Snapshot>>,
    last_roster_sig: &mut Option<u64>,
    last_channel_id: &mut Option<u64>,
) {
    let Ok(state) = con.get_state() else { return };
    let Some(own) = state.clients.get(&state.own_client) else { return };
    let channel_id = own.channel;
    let channel_name = state.channels.get(&channel_id).map(|c| c.name.clone()).unwrap_or_default();

    let own_client_id = own.id.0;
    let roster = build_roster(state, channel_id);
    let sig = roster_signature(&roster);

    {
        let mut snap = snapshot.lock().await;
        snap.connected = true;
        snap.channel_id = channel_id.0;
        snap.channel_name = channel_name.clone();
        snap.own_client_id = Some(own_client_id);
        snap.roster = roster.clone();
    }

    if *last_channel_id != Some(channel_id.0) {
        *last_channel_id = Some(channel_id.0);
        let _ = event_tx.send(BridgeEvent::State(StateSnapshot {
            connected: true,
            channel_id: channel_id.0,
            channel_name: channel_name.clone(),
            own_client_id: Some(own_client_id),
        }));
    }

    if *last_roster_sig != Some(sig) {
        *last_roster_sig = Some(sig);
        let _ = event_tx.send(BridgeEvent::Roster(roster));
    }
}

/// Cleanup owed by a full connection loss (mirrors `AudioState::on_disconnect`
/// plus the parts of the old ts_client.rs's disconnect handling that are
/// about the roster/state snapshot rather than the audio state): reset the
/// snapshot to disconnected and forget the last-broadcast state/roster
/// signature so a reconnect re-announces the same channel instead of
/// staying silent because "nothing changed" from the last (now stale)
/// broadcast.
pub async fn mark_disconnected(
    event_tx: &broadcast::Sender<BridgeEvent>,
    snapshot: &Arc<TokioMutex<Snapshot>>,
    last_roster_sig: &mut Option<u64>,
    last_channel_id: &mut Option<u64>,
) {
    snapshot.lock().await.set_disconnected();
    *last_channel_id = None;
    *last_roster_sig = None;
    let _ = event_tx.send(BridgeEvent::State(StateSnapshot {
        connected: false,
        channel_id: 0,
        channel_name: String::new(),
        own_client_id: None,
    }));
}
