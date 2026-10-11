//! Importing a user's own TeamSpeak identity from an exported `.ini` file.
//!
//! # Why this exists
//!
//! PHA-4116's original framing was that getting a TeamSpeak identity onto a
//! device required recovering TeamSpeak's myTeamSpeak account-sync protocol,
//! which would have meant reverse-engineering their native client and
//! impersonating the official app. That turned out to be the wrong question.
//!
//! A TeamSpeak identity is not an account object. It is a local ECC P-256 key
//! pair in a file. Nothing about it is stored on myTeamSpeak, no account is
//! needed to create or use one, and a game server never sees the account login
//! — it only sees the public key. The account is a *backup* facility for
//! identities that already live on your disk.
//!
//! So the import path is offline and file-based: the user exports an identity
//! `.ini` from a machine where they have the official client, PLNT reads it,
//! and hands the key to `tsclientlib`, which already speaks the protocol.
//!
//! `Identity::new_from_str` does the actual parsing — including TeamSpeak's
//! XOR "obfuscation", which is a published constant and not cryptography. This
//! module's job is the part that library does *not* do: pulling the identity
//! value out of the surrounding `.ini` syntax, and refusing to guess when the
//! file is ambiguous or the key does not parse.
//!
//! # What this module deliberately does not do
//!
//! - It never contacts `clientapi.myteamspeak.com` or any myTeamSpeak service.
//! - It never writes, uploads, or logs a private key. [`describe`] returns
//!   only public metadata — UID, security level, counter.
//! - It never creates, rotates, or upgrades an identity. Import is read-only.

use std::fmt;
use std::path::Path;

use tsclientlib::Identity;

/// The `.ini` key holding the identity blob.
const IDENTITY_KEY: &str = "identity";

/// A parsed identity file: the key, plus whatever descriptive metadata the
/// `.ini` carried alongside it.
#[derive(Debug, Clone)]
pub struct ImportedIdentity {
    /// The usable identity, ready to hand to a `Connection`.
    pub identity: Identity,
    /// The `name` field from the `.ini`, if present. Not used for
    /// authentication — it is a human label.
    pub name: Option<String>,
    /// The `nickname` field from the `.ini`, if present. Advisory only: the
    /// nickname actually used on a server is chosen at connect time.
    pub nickname: Option<String>,
}

impl ImportedIdentity {
    /// The public "Unique ID" a TeamSpeak server displays and keys
    /// permissions on. Safe to show, log, or type into a server admin.
    ///
    /// This is the base64 SHA-1 of the public key.
    pub fn uid(&self) -> String { self.identity.key().to_pub().get_uid() }

    /// Hashcash security level encoded by the identity's counter.
    pub fn level(&self) -> u8 { self.identity.level() }

    /// The counter value from the file, before any re-mining.
    pub fn counter(&self) -> u64 { self.identity.counter() }

    /// Public-only summary. Deliberately does **not** implement `Debug` with
    /// the key reachable, and deliberately has no `Display` that could
    /// accidentally stringify the secret into a log line.
    pub fn describe(&self) -> String {
        format!(
            "uid={} level={} counter={} name={} nickname={}",
            self.uid(),
            self.level(),
            self.counter(),
            self.name.as_deref().unwrap_or("-"),
            self.nickname.as_deref().unwrap_or("-"),
        )
    }
}

#[derive(Debug)]
pub enum ImportError {
    Io(std::io::Error),
    /// The file contained no `identity=` key at all.
    NoIdentityKey,
    /// More than one `identity=` key. We cannot guess which one the user
    /// meant, and picking one silently could import the wrong identity.
    MultipleIdentityKeys(usize),
    /// The `identity=` key had an empty value.
    EmptyIdentityValue,
    /// The value was present but `tsclientlib` could not parse it as a key.
    MalformedIdentity(String),
}

impl fmt::Display for ImportError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImportError::Io(e) => write!(f, "reading identity file: {e}"),
            ImportError::NoIdentityKey => {
                write!(f, "no `{IDENTITY_KEY}=` key found — is this a TeamSpeak identity export?")
            }
            ImportError::MultipleIdentityKeys(n) => write!(
                f,
                "found {n} `{IDENTITY_KEY}=` keys — refusing to guess which identity to import"
            ),
            ImportError::EmptyIdentityValue => {
                write!(f, "`{IDENTITY_KEY}=` was present but empty")
            }
            ImportError::MalformedIdentity(reason) => {
                write!(f, "identity value is not a valid TeamSpeak key: {reason}")
            }
        }
    }
}

impl std::error::Error for ImportError {}

impl From<std::io::Error> for ImportError {
    fn from(e: std::io::Error) -> Self {
        ImportError::Io(e)
    }
}

/// Import an identity from a `.ini` file on disk.
pub fn import_from_file(path: impl AsRef<Path>) -> Result<ImportedIdentity, ImportError> {
    let text = std::fs::read_to_string(path)?;
    import_from_ini(&text)
}

/// Import an identity from the text of a `.ini` file.
///
/// Handles the shapes TeamSpeak's own exporter produces across client versions:
/// bare `key=value`, quoted values, CRLF line endings, leading whitespace,
/// comment lines, and `key = value` spacing. The identity value itself is
/// passed through to `tsclientlib` verbatim apart from surrounding quotes and
/// whitespace, because that library owns the format.
pub fn import_from_ini(text: &str) -> Result<ImportedIdentity, ImportError> {
    let mut identity_values: Vec<&str> = Vec::new();
    let mut name = None;
    let mut nickname = None;

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = unquote(value.trim());
        match key {
            IDENTITY_KEY => identity_values.push(value),
            "name" => name = Some(value.to_string()),
            "nickname" => nickname = Some(value.to_string()),
            _ => {}
        }
    }

    match identity_values.len() {
        0 => return Err(ImportError::NoIdentityKey),
        1 => {}
        n => return Err(ImportError::MultipleIdentityKeys(n)),
    }

    let raw = identity_values[0];
    if raw.is_empty() {
        return Err(ImportError::EmptyIdentityValue);
    }

    // `new_from_str` tries the `COUNTER||'V'||key` form first and falls back
    // to a bare key. Both are legitimate exports; either way the parse is the
    // library's job, and a failure here means the file is not what it claims.
    let identity = Identity::new_from_str(raw)
        .map_err(|e| ImportError::MalformedIdentity(format!("{e:?}")))?;

    Ok(ImportedIdentity { identity, name, nickname })
}

/// Strip a matched pair of surrounding quotes, if present.
///
/// TeamSpeak's exporter quotes some values and not others depending on client
/// version; the identity value is stored quoted in the common case.
fn unquote(value: &str) -> &str {
    let bytes = value.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real TeamSpeak-format export: the value is
    // `COUNTER || 'V' || base64(obfuscate(base64(ASN.1 private key)))`, quoted
    // as the official exporter writes it. This is the `tsaudiobot` test vector
    // that ships in tsclientlib's own test suite.
    const SAMPLE: &str = "MCkDAgbAAgEgAiBhPImh+bO1xMGOrcplwN3G74bhE9XATm+DxVo3aNtBqg==";

    #[test]
    fn parses_bare_identity_value() {
        let text = format!("[Identity]\nname=a@b.c\nnickname=Friend\nidentity={SAMPLE}\n");
        let imported = import_from_ini(&text).expect("should parse");
        assert_eq!(imported.name.as_deref(), Some("a@b.c"));
        assert_eq!(imported.nickname.as_deref(), Some("Friend"));
        // tsclientlib's own fixture asserts this UID for this key.
        assert_eq!(imported.uid(), "test/9PZ9vww/Bpf5vJxtJhpz80=");
    }

    #[test]
    fn parses_quoted_identity_value() {
        let text = format!("[Identity]\nidentity=\"{SAMPLE}\"\n");
        let imported = import_from_ini(&text).expect("should parse");
        assert_eq!(imported.uid(), "test/9PZ9vww/Bpf5vJxtJhpz80=");
    }

    #[test]
    fn tolerates_crlf_and_spacing_and_comments() {
        let text = format!(
            "; exported by TeamSpeak\r\n[Identity]\r\n  identity = \"{SAMPLE}\"  \r\n"
        );
        let imported = import_from_ini(&text).expect("should parse");
        assert_eq!(imported.uid(), "test/9PZ9vww/Bpf5vJxtJhpz80=");
    }

    #[test]
    fn rejects_missing_key() {
        let err = import_from_ini("[Identity]\nnickname=Friend\n").unwrap_err();
        assert!(matches!(err, ImportError::NoIdentityKey));
    }

    #[test]
    fn rejects_empty_value() {
        let err = import_from_ini("[Identity]\nidentity=\n").unwrap_err();
        assert!(matches!(err, ImportError::EmptyIdentityValue));
    }

    #[test]
    fn refuses_to_guess_between_multiple_identities() {
        let text = format!("[Identity]\nidentity={SAMPLE}\nidentity={SAMPLE}\n");
        let err = import_from_ini(&text).unwrap_err();
        assert!(matches!(err, ImportError::MultipleIdentityKeys(2)));
    }

    #[test]
    fn rejects_malformed_value() {
        let err = import_from_ini("[Identity]\nidentity=not-a-real-key\n").unwrap_err();
        assert!(matches!(err, ImportError::MalformedIdentity(_)));
    }

    #[test]
    fn describe_leaks_no_key_material() {
        let text = format!("[Identity]\nidentity={SAMPLE}\n");
        let imported = import_from_ini(&text).unwrap();
        let described = imported.describe();
        // The UID is safe to show; the key blob must never appear in it.
        assert!(described.contains("test/9PZ9vww/Bpf5vJxtJhpz80="));
        assert!(!described.contains(SAMPLE));
    }
}