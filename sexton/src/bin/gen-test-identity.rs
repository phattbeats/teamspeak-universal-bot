// One-off helper (PHA-4116): produce a genuine TeamSpeak identity export so
// `identity-tool` can be exercised against a real export rather than the
// hand-written test fixture. Generates a fresh identity, serialises it in the
// exact `.ini` shape TeamSpeak's exporter writes, and prints the path.
//
// This deliberately prints the identity to the file only — never to stdout.

use anyhow::Result;
use tsclientlib::Identity;

fn main() -> Result<()> {
    let mut id = Identity::create();
    id.upgrade_level(8);

    let counter = id.counter();
    let blob = id.key().to_ts_obfuscated();
    let value = format!("{counter}V{blob}");

    let ini = format!(
        "[Identity]\nname=pha4116-test@invalid.example\nnickname=PHA4116Test\nidentity=\"{value}\"\n"
    );

    std::fs::write("/tmp/friend-identity.ini", ini)?;
    println!("wrote /tmp/friend-identity.ini (uid={})", id.key().to_pub().get_uid());
    Ok(())
}