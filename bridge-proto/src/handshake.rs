//! Sexton ↔ ts-bridge handshake over the Unix socket.
//!
//! The first frame the Sexton sends after `accept()` is a `Hello` with the
//! connection state known at accept-time (the Sexton may already be
//! connected — the bridge reconnects after a Sexton restart and we want
//! the WS server to come up populated, not empty). The bridge replies with
//! a `HelloAck` once it has spawned the WS server and the mixer; only then
//! does the Sexton start sending `BridgeEvent`s.
//!
//! The handshake is intentionally minimal. There is no auth token: the
//! socket lives on a Docker-shared volume only mounted into the two
//! containers that compose the Sexton (Sexton text + ts-bridge). The host's
//! `appdata/sexton-bridge` directory is 0755 and the file itself is 0660
//! to root. Adding a token would mean a secret to rotate; the volume
//! boundary already provides the access control that matters.

use serde::{Deserialize, Serialize};

use crate::events::{RosterEntry, StateSnapshot};

/// First frame the Sexton sends after accepting a bridge connection.
/// Carries enough state that the bridge can serve its WS clients
/// immediately, without waiting for the next server-sent event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Hello {
    /// Sexton's protocol version. Bump on breaking wire changes. Today:
    /// `1` (#3341 initial).
    pub version: u32,
    pub state: StateSnapshot,
    pub roster: Vec<RosterEntry>,
    /// The Sexton's read-only channel name (the watched channel — the
    /// bridge has no business joining other channels; ts3's voice tools
    /// use this to know where "here" is). Empty until the channel tree
    /// has resolved.
    pub watched_channel: String,
}

/// Bridge's reply. The Sexton does not strictly require a reply before
/// sending events — `HelloAck` exists so the bridge can synchronously
/// confirm it has spawned the WS server and is ready to serve clients.
/// Without it, a fast hand-off could race the bridge's `accept` task.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct HelloAck {
    /// Must equal `Hello::version`. Mismatch → the bridge closes the
    /// socket; the Sexton logs and reconnects after backoff.
    pub version: u32,
    /// Bridge-side WebSocket bind address, recorded by the Sexton for the
    /// closing evidence table (#2501) so the operator can see which
    /// endpoint the Sexton's `depends_on` resolved.
    #[serde(rename = "wsBind")]
    pub ws_bind: String,
}