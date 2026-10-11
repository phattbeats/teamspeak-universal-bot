//! Validate a TeamSpeak identity `.ini` export and, optionally, prove it
//! against a server.
//!
//! PHA-4116: the report concluded a user-supplied identity importer is viable
//! because `tsclientlib` already parses exported identities and the Sexton
//! already ingests them. This tool is that claim, made runnable.
//!
//! Default mode is offline and read-only — it parses the file and prints
//! public metadata (UID, security level, counter). It never prints the private
//! key, and never contacts myTeamSpeak.
//!
//! `--connect` additionally dials a TeamSpeak server with the imported
//! identity to prove it authenticates. That is the only network path here, and
//! it is an ordinary server connection using the user's own key — the same
//! thing the official client does.
//!
//!     identity-tool --file friend.ini
//!     identity-tool --file friend.ini --connect teamspeak.phatt.vip:9987

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use clap::Parser;
use futures::StreamExt;
use tracing::info;

use tsclientlib::{Connection, DisconnectOptions, Identity, StreamItem};

use sexton::identity_file::import_from_file;

#[derive(Parser, Debug)]
struct Args {
    /// Path to an exported TeamSpeak identity `.ini`.
    #[arg(short, long)]
    file: PathBuf,

    /// Optional nickname to connect with. Defaults to the `nickname` in the
    /// file, else `PLNT-Import`.
    #[arg(short, long)]
    nickname: Option<String>,

    /// Prove the imported identity against a server. Accepts `host` or
    /// `host:port`. Omitted = fully offline, no network access at all.
    #[arg(short, long, value_name = "HOST[:PORT]")]
    connect: Option<String>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();
    let args = Args::parse();

    // Offline by default. Nothing above this point touches the network.
    let imported = import_from_file(&args.file).map_err(|e| anyhow!("{e}"))?;

    println!("{}", imported.describe());

    let Some(addr) = args.connect.clone() else {
        println!("parsed OK (offline; pass --connect to prove it against a server)");
        return Ok(());
    };

    let nickname = args
        .nickname
        .clone()
        .or_else(|| imported.nickname.clone())
        .unwrap_or_else(|| "PLNT-Import".to_string());

    let identity: Identity = imported.identity;

    let mut con = Connection::build(addr.clone())
        .identity(identity)
        .name(nickname.clone())
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;

    // tsclientlib only applies book updates while its stream is polled, so
    // `connect()` returning is not enough — wait for the first BookEvents
    // batch, which means the server accepted the imported identity. Same
    // pattern sexton/src/main.rs uses for the bot's own identity.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    let connected = loop {
        match tokio::time::timeout_at(deadline, con.events().next()).await {
            Ok(Some(Ok(StreamItem::BookEvents(_)))) => break true,
            Ok(Some(Ok(_))) => continue,
            Ok(Some(Err(e))) => return Err(anyhow!("stream error before connection: {e}")),
            Ok(None) => break false,
            Err(_) => break false,
        }
    };

    if !connected {
        return Err(anyhow!("timed out waiting for the server to accept the identity"));
    }

    let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
    info!(server = %state.server.name, "connected");
    let own_id = state.own_client;
    let nickname_used = state
        .clients
        .get(&own_id)
        .map(|c| c.name.clone())
        .unwrap_or_else(|| nickname.clone());
    println!("AUTHENTICATED on {} as {}", state.server.name, nickname_used);

    con.disconnect(DisconnectOptions::new()).ok();
    Ok(())
}