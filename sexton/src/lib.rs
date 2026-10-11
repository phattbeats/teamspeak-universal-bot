//! Shared library surface for the Sexton.
//!
//! PHA-4116: `identity_file` is the reusable half of the TeamSpeak identity
//! import path — it parses a user-exported identity `.ini` into something
//! `tsclientlib` can authenticate with. It lives in the lib target so both the
//! `identity-tool` verification binary and (later) the Android client can use
//! it, rather than duplicating the parse.

pub mod identity_file;