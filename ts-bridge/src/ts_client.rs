//! The TS6 connection: joins the configured channel, decodes per-speaker
//! Opus into the outbound event stream, and encodes the mixer's output back
//! out as Opus on a 20 ms tick.
//!
//! Carries the TS6 patches noted in the PHA-3099 epic findings: tsclientlib's
//! own connect handshake does not request the channel list or subscribe to
//! all channels against TS6 the way it did against TS3 (finding #6), so both
//! are sent explicitly right after connect; PM/poke targets always use the
//! live, just-observed `ClientId` from state rather than any cached/db id.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate};
use base64::prelude::*;
use futures::prelude::*;
use tokio::sync::{broadcast, mpsc};

use tsclientlib::messages::c2s::{
    OutChannelListRequestMessage, OutClientMoveMessage, OutClientMovePart,
};
use tsclientlib::{ChannelId, ClientId, Connection, DisconnectOptions, Identity, MessageTarget, OutCommandExt, StreamItem};
use tsproto_packets::packets::{AudioData, CodecType, OutAudio};

use crate::config::Config;
use crate::mixer::{Mixer, FRAME_SAMPLES};
use crate::protocol::RosterEntry;

/// How long to wait for the server to answer our `channellist` request before
/// giving up on resolving the configured channel and staying put.
const CHANNEL_TREE_TIMEOUT: Duration = Duration::from_secs(15);

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

pub enum BridgeCommand {
    Join { channel: String },
    Mute { muted: bool },
    Poke { client_id: u16, text: String },
    SendText { target: SendTarget, text: String },
}

pub enum SendTarget {
    Channel,
    Server,
    Client(u16),
}

#[derive(Clone)]
pub enum BridgeEvent {
    SpeakerAudio { client_id: u16, nickname: String, seq: u32, pcm: Vec<i16> },
    SpeakerStart { client_id: u16 },
    SpeakerStop { client_id: u16 },
    Roster(Vec<RosterEntry>),
    TextMessage { client_id: u16, nickname: String, text: String, target: &'static str },
    State { connected: bool, channel_id: u64, channel_name: String },
}

/// Export an identity in the standard TS3 `"<counter>V<base64key>"` form so
/// a human can paste it straight into Paperclip secrets or a TS client.
pub fn export_identity(id: &Identity) -> String {
    format!("{}V{}", id.counter(), BASE64_STANDARD.encode(id.key().to_short()))
}

fn resolve_channel_id(state: &tsclientlib::data::Connection, spec: &str) -> Option<ChannelId> {
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
        })
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

pub async fn run(
    config: &Config,
    mixer: Arc<Mutex<Mixer>>,
    cmd_rx: &mut mpsc::UnboundedReceiver<BridgeCommand>,
    event_tx: broadcast::Sender<BridgeEvent>,
) -> anyhow::Result<()> {
    let identity = match &config.identity {
        Some(s) => Identity::new_from_str(s).map_err(|e| anyhow::anyhow!("bad TS_IDENTITY: {e:?}"))?,
        None => {
            let id = Identity::create();
            log::warn!(
                "TS_IDENTITY not set; generated a fresh identity for this run. Persist it or the \
                 bridge reconnects as a new bot every restart: {}",
                export_identity(&id)
            );
            id
        }
    };

    let mut builder = Connection::build(config.server_address.clone())
        .identity(identity)
        .name(config.nickname.clone());
    if let Some(pwd) = &config.password {
        builder = builder.password(pwd.clone());
    }
    let mut con = builder.connect().map_err(|e| anyhow::anyhow!("connect: {e}"))?;

    // Wait for the first book-events batch (server accepted us).
    let first_book = con
        .events()
        .try_filter(|e| future::ready(matches!(e, StreamItem::BookEvents(_))))
        .next()
        .await;
    match first_book {
        Some(Ok(_)) => {}
        Some(Err(e)) => anyhow::bail!("first book events failed: {e}"),
        None => anyhow::bail!("stream ended before first book events"),
    }

    // --- TS6 patches: explicit channel list + subscribe-all -----------------
    // Against TS3 the initial handshake pushes the whole channel list and
    // audio for the client's channel unprompted; TS6 does not, so both are
    // requested explicitly here (PHA-3099 finding #6).
    OutChannelListRequestMessage::new()
        .send(&mut con)
        .map_err(|e| anyhow::anyhow!("channellist request: {e}"))?;
    {
        let state = con.get_state().map_err(|e| anyhow::anyhow!("get_state: {e}"))?;
        state.server.set_subscribed(true).send(&mut con).map_err(|e| anyhow::anyhow!("channelsubscribeall: {e}"))?;
    }

    // Join the configured channel, if any. Wait for the `channellist` answer
    // by pumping the event stream, not by sleeping: tsclientlib only advances
    // the connection — and applies book updates — while its event stream is
    // polled, so a bare sleep leaves `state.channels` empty and the channel
    // unresolvable no matter how long we wait (PHA-3216; same bug the bot hit
    // in caa58c0).
    if !config.channel.is_empty() && config.channel != "0" {
        let deadline = tokio::time::Instant::now() + CHANNEL_TREE_TIMEOUT;
        let target = loop {
            {
                let state = con.get_state().map_err(|e| anyhow::anyhow!("get_state: {e}"))?;
                if let Some(id) = resolve_channel_id(state, &config.channel) {
                    break Some(id);
                }
            }
            match tokio::time::timeout_at(deadline, con.events().next()).await {
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(e))) => anyhow::bail!("waiting for channel list: {e}"),
                Ok(None) => anyhow::bail!("stream ended while waiting for channel list"),
                Err(_) => break None,
            }
        };
        match target {
            Some(channel_id) => {
                let own_client = con.get_state().ok().map(|s| s.own_client);
                if let Some(own) = own_client {
                    let mut parts = std::iter::once(OutClientMovePart {
                        client_id: own,
                        channel_id,
                        channel_password: None,
                    });
                    OutClientMoveMessage::new(&mut parts)
                        .send(&mut con)
                        .map_err(|e| anyhow::anyhow!("join channel: {e}"))?;
                }
            }
            None => log::warn!(
                "configured channel '{}' not found in channel list after {}s",
                config.channel,
                CHANNEL_TREE_TIMEOUT.as_secs()
            ),
        }
    }

    let mut voice_encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
        .map_err(|e| anyhow::anyhow!("voice opus encoder: {e:?}"))?;
    let mut music_encoder = Encoder::new(SampleRate::Hz48000, Channels::Mono, Application::Audio)
        .map_err(|e| anyhow::anyhow!("music opus encoder: {e:?}"))?;
    music_encoder
        .set_bitrate(Bitrate::BitsPerSecond(64_000))
        .map_err(|e| anyhow::anyhow!("music opus bitrate: {e:?}"))?;

    let mut audio = tsclientlib::audio::AudioHandler::default();
    let mut known_talkers: HashSet<u16> = HashSet::new();
    let mut speaker_seq: HashMap<u16, u32> = HashMap::new();
    let mut last_roster_sig: Option<u64> = None;
    let mut last_channel_id: Option<u64> = None;
    let mut muted = false;
    let mut tick_count: u64 = 0;
    // Whether we are mid-transmission, so we know when to emit the
    // stop-talking marker. `last_codec` tags that marker with the codec the
    // stream was actually using.
    let mut sending = false;
    let mut last_codec = CodecType::OpusVoice;
    let mut silent_frames: u32 = 0;
    // Receive-path telemetry, logged at 1 Hz next to the send tick.
    let mut dropped_packets: u64 = 0;
    let mut recv_frames: u64 = 0;
    let mut recv_peak: u16 = 0;
    // Scratch mix buffer for `fill_buffer_with_proc`: one 20 ms interleaved
    // stereo frame. We only want the per-speaker tap, not the mix, but the call
    // needs a correctly sized buffer to know how much to pull.
    let mut mix = vec![0f32; FRAME_SAMPLES * TS_DECODE_CHANNELS];

    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Announce initial state once we know our channel.
    emit_state_and_roster(&mut con, &event_tx, &mut last_roster_sig, &mut last_channel_id);

    // `Connection::events()` hands out a stream that mutably borrows the
    // connection for as long as it lives, and `select!` keeps every branch
    // future alive for the whole statement. So the select only *waits*: it
    // pulls the owned wakeup out, drops the event stream, and the handlers
    // below get `con` back to themselves.
    enum Wake {
        Cmd(Option<BridgeCommand>),
        Tick,
        Event(Option<Result<StreamItem, tsclientlib::Error>>),
    }

    loop {
        let wake = {
            let mut events = con.events();
            tokio::select! {
                biased;
                cmd = cmd_rx.recv() => Wake::Cmd(cmd),
                _ = tick.tick() => Wake::Tick,
                ev = events.next() => Wake::Event(ev),
            }
        };

        match wake {
            Wake::Cmd(cmd) => {
                match cmd {
                    Some(BridgeCommand::Join { channel }) => {
                        let target = con.get_state().ok().and_then(|s| resolve_channel_id(s, &channel));
                        if let Some(channel_id) = target {
                            let own_client = con.get_state().ok().map(|s| s.own_client);
                            if let Some(own) = own_client {
                                let mut parts = std::iter::once(OutClientMovePart {
                                    client_id: own,
                                    channel_id,
                                    channel_password: None,
                                });
                                if let Err(e) = OutClientMoveMessage::new(&mut parts).send(&mut con) {
                                    log::warn!("join failed: {e}");
                                }
                            }
                        } else {
                            log::warn!("join: channel '{channel}' not found");
                        }
                    }
                    Some(BridgeCommand::Mute { muted: m }) => {
                        muted = m;
                    }
                    Some(BridgeCommand::Poke { client_id, text }) => {
                        if let Ok(state) = con.get_state() {
                            let cmd = state.send_message(MessageTarget::Poke(ClientId(client_id)), &text);
                            if let Err(e) = cmd.send(&mut con) {
                                log::warn!("poke failed: {e}");
                            }
                        }
                    }
                    Some(BridgeCommand::SendText { target, text }) => {
                        if let Ok(state) = con.get_state() {
                            let msg_target = match target {
                                SendTarget::Channel => MessageTarget::Channel,
                                SendTarget::Server => MessageTarget::Server,
                                SendTarget::Client(id) => MessageTarget::Client(ClientId(id)),
                            };
                            let cmd = state.send_message(msg_target, &text);
                            if let Err(e) = cmd.send(&mut con) {
                                log::warn!("send_text failed: {e}");
                            }
                        }
                    }
                    None => break,
                }
            }

            Wake::Tick => {
                // --- receive: pull exactly one 20 ms frame per speaker -----
                //
                // `fill_buffer_with_proc` is the upstream-blessed per-speaker
                // tap: it hands each queue's own samples to the closure before
                // mixing them into `mix`, and returns the talkers that ended —
                // either end-of-stream or too many consecutive packet losses,
                // which is how a dead queue gets retired instead of emitting
                // concealment silence forever.
                mix.fill(0.0);
                let mut drained: Vec<(u16, Vec<f32>)> = Vec::new();
                let ended = audio.fill_buffer_with_proc(&mut mix, |id: &ClientId, samples: &[f32]| {
                    if !samples.is_empty() {
                        drained.push((id.0, samples.to_vec()));
                    }
                });

                if !drained.is_empty() {
                    // Name each queue from its own client: draining is
                    // per-speaker, so tagging frames with whoever's packet
                    // happened to wake us up would mislabel audio as soon as
                    // two people talk at once.
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
                        recv_peak = recv_peak.max(pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0));
                        recv_frames = recv_frames.wrapping_add(1);
                        let seq = speaker_seq.entry(cid).or_insert(0);
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
                    if known_talkers.remove(&id.0) {
                        let _ = event_tx.send(BridgeEvent::SpeakerStop { client_id: id.0 });
                    }
                }
                if known_talkers.is_empty() {
                    mixer.lock().unwrap().set_human_speaking(false);
                }

                // --- send ------------------------------------------------
                if muted {
                    // Going muted mid-utterance still owes the channel a
                    // stop-talking marker, or we leave every listener holding
                    // an open stream from us.
                    if sending {
                        let stop = OutAudio::new(&AudioData::C2S { id: 0, codec: last_codec, data: &[] });
                        if let Err(e) = con.send_audio(stop) {
                            log::warn!("send stop-talking failed: {e}");
                        }
                        sending = false;
                    }
                    continue;
                }
                let (frame, lanes) = {
                    let mut m = mixer.lock().unwrap();
                    let frame = m.next_frame();
                    (frame, m.lanes())
                };
                let peak = frame.samples.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);

                // 1 Hz send-path telemetry: enough to tell "nothing is
                // reaching the mixer" from "the mixer is full but the
                // channel is silent" without attaching a debugger. Logged
                // before the send decision so the tick keeps reporting while
                // we are deliberately transmitting nothing.
                tick_count = tick_count.wrapping_add(1);
                if tick_count % 50 == 0 {
                    log::debug!(
                        "send tick: voice_queued={} music_queued={} duck={:.2} music_active={} peak={} sending={} | recv: talkers={} frames/s={} peak={} dropped={}",
                        lanes.0,
                        lanes.1,
                        lanes.2,
                        frame.music_active,
                        peak,
                        sending,
                        known_talkers.len(),
                        recv_frames,
                        recv_peak,
                        dropped_packets
                    );
                    recv_frames = 0;
                    recv_peak = 0;
                }

                // Stop transmitting when we have nothing to say, instead of
                // streaming Opus-encoded silence forever (PHA-3216).
                //
                // A bridge that never stops sending is "talking" as far as
                // every other client is concerned. Between two bridges that is
                // not just wasted bandwidth: each one's `known_talkers` never
                // empties, so `human_speaking` is pinned true and the music
                // lane sits at the duck floor permanently — the un-ducked
                // window never comes back and the ducking is unmeasurable.
                // A zero-length payload is the protocol's stop-talking marker.
                //
                // The hangover keeps the stream open across short gaps. Without
                // it, the pauses between words in a TTS utterance — or a quiet
                // passage in music — would each close and reopen the stream,
                // spamming every listener with speaker_start/speaker_stop and
                // making them re-open a jitter buffer mid-sentence.
                if peak > 0 {
                    silent_frames = 0;
                } else {
                    silent_frames = silent_frames.saturating_add(1);
                    // The hangover only holds an *already open* stream open. If
                    // we are not mid-utterance there is nothing to ride over, and
                    // sending silence here would open a stream just to close it
                    // 200 ms later — which is what made an idle bridge emit a
                    // spurious speaker_start/speaker_stop pair on connect.
                    if !sending {
                        continue;
                    }
                }
                if peak == 0 && silent_frames >= SILENCE_HANGOVER_FRAMES {
                    if sending {
                        let stop = OutAudio::new(&AudioData::C2S { id: 0, codec: last_codec, data: &[] });
                        if let Err(e) = con.send_audio(stop) {
                            log::warn!("send stop-talking failed: {e}");
                        }
                        sending = false;
                    }
                    continue;
                }

                let encoder = if frame.music_active { &mut music_encoder } else { &mut voice_encoder };
                let codec = if frame.music_active { CodecType::OpusMusic } else { CodecType::OpusVoice };
                let mut out_buf = [0u8; 1275];
                match encoder.encode(&frame.samples, &mut out_buf) {
                    Ok(len) => {
                        let pkt = OutAudio::new(&AudioData::C2S { id: 0, codec, data: &out_buf[..len] });
                        if let Err(e) = con.send_audio(pkt) {
                            log::warn!("send_audio failed: {e}");
                        }
                        sending = true;
                        last_codec = codec;
                    }
                    Err(e) => log::warn!("opus encode failed: {e:?}"),
                }
            }

            Wake::Event(ev) => {
                match ev {
                    Some(Ok(StreamItem::Audio(audio_pkt))) => {
                        let from_raw: u16 = match audio_pkt.data().data() {
                            AudioData::S2C { from, .. } => *from,
                            _ => continue,
                        };
                        let from_id = ClientId(from_raw);

                        // Queue only. Draining happens on the 20 ms tick, not
                        // here: tsclientlib's jitter buffer measures time by
                        // how many samples it has handed out, so it has to be
                        // pulled on a steady clock. Draining once per arriving
                        // packet — and asking for FRAME_SAMPLES *interleaved*
                        // values, which is 10 ms of stereo, not 20 ms of mono —
                        // consumed half of what arrived, so the queue backed up
                        // to `QueueFull`, rejected every later packet, and then
                        // handed out packet-loss concealment forever. That is
                        // the exact digital silence PHA-3216 measured while
                        // Brandon could hear the tone in the channel.
                        match audio.handle_packet(from_id, audio_pkt) {
                            Ok(_) => {
                                if known_talkers.insert(from_raw) {
                                    let _ = event_tx.send(BridgeEvent::SpeakerStart { client_id: from_raw });
                                    mixer.lock().unwrap().set_human_speaking(true);
                                }
                            }
                            Err(e) => {
                                // Never silent: a queue that rejects packets is
                                // indistinguishable, on the wire, from a silent
                                // channel.
                                dropped_packets = dropped_packets.wrapping_add(1);
                                if dropped_packets % 50 == 1 {
                                    log::warn!(
                                        "dropped inbound audio from client {from_raw}: {e} ({dropped_packets} dropped so far)"
                                    );
                                }
                            }
                        }
                    }
                    Some(Ok(StreamItem::BookEvents(events))) => {
                        for ev in &events {
                            if let tsclientlib::events::Event::Message { target, invoker, message } = ev {
                                let target_str = match target {
                                    MessageTarget::Channel => "channel",
                                    MessageTarget::Server => "server",
                                    MessageTarget::Client(_) => "client",
                                    MessageTarget::Poke(_) => "poke",
                                };
                                let _ = event_tx.send(BridgeEvent::TextMessage {
                                    client_id: invoker.id.0,
                                    nickname: invoker.name.clone(),
                                    text: message.clone(),
                                    target: target_str,
                                });
                            }
                        }
                        emit_state_and_roster(&mut con, &event_tx, &mut last_roster_sig, &mut last_channel_id);
                    }
                    Some(Ok(StreamItem::DisconnectedTemporarily(reason))) => {
                        log::warn!("temporary disconnect: {reason:?}");
                        // Nobody can be mid-sentence across a disconnect, and
                        // their `speaker_stop` is never coming. Without this
                        // the duck flag latches on and the music lane stays at
                        // 0.25 forever — the mixer outlives the connection.
                        for cid in known_talkers.drain() {
                            let _ = event_tx.send(BridgeEvent::SpeakerStop { client_id: cid });
                        }
                        mixer.lock().unwrap().set_human_speaking(false);
                        let _ = event_tx.send(BridgeEvent::State { connected: false, channel_id: 0, channel_name: String::new() });
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => log::warn!("event stream error: {e}"),
                    None => break,
                }
            }
        }
    }

    // Same for the loop exiting outright: `main` reconnects with a fresh
    // connection but the same mixer, so leave the duck envelope released.
    for cid in known_talkers.drain() {
        let _ = event_tx.send(BridgeEvent::SpeakerStop { client_id: cid });
    }
    mixer.lock().unwrap().set_human_speaking(false);

    let _ = con.disconnect(DisconnectOptions::new());
    let _ = event_tx.send(BridgeEvent::State { connected: false, channel_id: 0, channel_name: String::new() });
    Ok(())
}

fn emit_state_and_roster(
    con: &mut Connection,
    event_tx: &broadcast::Sender<BridgeEvent>,
    last_roster_sig: &mut Option<u64>,
    last_channel_id: &mut Option<u64>,
) {
    let Ok(state) = con.get_state() else { return };
    let Some(own) = state.clients.get(&state.own_client) else { return };
    let channel_id = own.channel;
    let channel_name = state
        .channels
        .get(&channel_id)
        .map(|c| c.name.clone())
        .unwrap_or_default();

    if *last_channel_id != Some(channel_id.0) {
        *last_channel_id = Some(channel_id.0);
        let _ = event_tx.send(BridgeEvent::State { connected: true, channel_id: channel_id.0, channel_name: channel_name.clone() });
    }

    let roster = build_roster(state, channel_id);
    let sig = roster_signature(&roster);
    if *last_roster_sig != Some(sig) {
        *last_roster_sig = Some(sig);
        let _ = event_tx.send(BridgeEvent::Roster(roster));
    }
}
