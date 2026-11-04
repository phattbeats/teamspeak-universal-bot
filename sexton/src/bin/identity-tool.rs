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
use tracing::info;

use tsclientlib::prelude::*;
use tsclientlib::{Connection, DisconnectOptions, Identity};

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

    // tsclientlib only applies book updates while its stream is polled, so
    // connect() returning is not enough — we must pump until connected.
    let mut con = Connection::build(addr.clone())
        .identity(identity)
        .name(nickname)
        .connect()
        .map_err(|e| anyhow!("connect: {e}"))?;

    match con.wait_connected().await {
        Ok(()) => {}
        Err(e) => return Err(anyhow!("waiting for connection to {addr}: {e}")),
    }

    let state = con.get_state().map_err(|e| anyhow!("get_state: {e}"))?;
    info!(server = %state.server.name, "connected");
    println!(
        "AUTHENTICATED on {} as {}",
        state.server.name, state.self_client.name
    );

    con.disconnect(DisconnectOptions::new()).ok();
    Ok(())
}