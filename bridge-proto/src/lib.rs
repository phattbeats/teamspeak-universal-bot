//! bridge-proto — the contract between the Sexton (tsclientlib owner) and
//! the ts-bridge sidecar.
//!
//! ## Why this crate exists (PHA-3341)
//!
//! Before this crate, the Sexton and ts-bridge each opened their *own*
//! tsclientlib connection. Both connected as a "Sexton" identity (the text
//! Sexton as `Sexton`, the bridge as `Sexton-Bridge` — same server group,
//! separate clients) because the two containers evolved on independent
//! tracks: the Sexton in PHA-3173 for the text lane, the bridge in PHA-3174
//! for the audio lane. The two-client shape was the right starting
//! hypothesis (the only Rust crates that already spoke tsclientlib for audio
//! were written against a fresh client) but it leaks: the channel roster
//! shows two Sextons, and the bridge's TS identity has to be pinned in a
//! second Paperclip secret.
//!
//! This crate does NOT change the wire protocol of the WebSocket the bridge
//! exposes to clients (`PROTOCOL.md` — that lives in `ts-bridge/src/protocol.rs`
//! until/unless it grows a second consumer). What it does is move the
//! *internal* bridge IPC — `BridgeEvent`, `BridgeCommand`, the roster
//! snapshot, and the connection-state shape — into one place so the Sexton
//! can publish them and the bridge can subscribe to them.
//!
//! ## Handshake
//!
//! 1. The Sexton owns the `tsclientlib::Connection`. It binds a Unix domain
//!    socket on a Docker-shared volume (`--bridge-socket <path>`, default
//!    `/run/sexton/bridge.sock`).
//! 2. The ts-bridge container starts, waits for the socket to appear
//!    (`SEXTON_BRIDGE_SOCKET`), and dials it.
//! 3. The connection carries a length-prefixed JSON message stream. The
//!    first frame from the Sexton is a `Hello { own_client_id, channel_id,
//!    channel_name }` so the bridge can start emitting state frames
//!    immediately, before the first server-sent event has arrived.
//! 4. The Sexton fans out events from `con.events()` to every connected
//!    bridge (broadcast). Commands from the bridge (`Join`, `SendText`,
//!    etc.) are applied to the single `Connection` via a serialized
//!    request/response channel so the Sexton's event loop stays the only
//!    writer.
//!
//! ## Failure model
//!
//! The bridge dies if the Sexton dies — by design (one connection, one
//! process). The Sexton emits a `State { connected: false, .. }` event on
//! every disconnect so the bridge's `Mixer` releases the duck envelope
//! (PHA-3174's standing requirement: never leave the channel stuck ducked).
//!
//! The bridge reconnects if its Unix-socket dial fails (Sexton is
//! restarting, container race): exponential backoff capped at 60 s, same
//! shape as the bridge's existing TS reconnect loop.

pub mod codec;
pub mod events;
pub mod handshake;

pub use codec::{decode_frame, encode_frame, FrameError, FrameType, RawFrame};
pub use events::{
    BridgeCommand, BridgeEvent, ChannelInfo, RosterEntry, SendTarget, Snapshot, StateSnapshot,
};
pub use handshake::{Hello, HelloAck};

/// Default path for the Sexton's Unix socket inside the shared Docker volume.
/// Both containers mount `/run/sexton` from the same `appdata/sexton-bridge`
/// volume so the bridge can dial `Sexton` even though they share a process
/// group on the host — the bridge never reaches the Sexton's PID directly.
pub const DEFAULT_SOCKET_PATH: &str = "/run/sexton/bridge.sock";

/// How long the bridge waits for the socket to appear before giving up on
/// a single dial attempt. Short enough that the loop is responsive on
/// normal boot (text Sexton's connect happens in <2 s), long enough that
/// the very first attempt does not always fail under compose `depends_on`.
pub const SOCKET_READY_POLL_MS: u64 = 500;