//! ESO bearer-token refresher core — Rust parity port of the TypeScript
//! `src/eso-refresher` (SMOODEV-1526, epic SMOODEV-1522).
//!
//! ESO's webhook provider reads a STATIC bearer from a k8s Secret, but the
//! config API issues short-lived `client_credentials` JWTs (~1h) — so a static
//! token goes stale and ESO sync silently 401s. This refresher re-mints the
//! token on a short interval via the same `TokenProvider` the SDK uses and
//! writes it into the bootstrap Secret, so ESO always reads a fresh bearer.
//!
//! The k8s write is abstracted behind [`SecretWriter`] so the loop is
//! unit-testable with a fake (no live cluster). A native `kube`-backed writer is
//! an optional adapter (kept out of this core so base SDK consumers do not pull
//! a heavy k8s client) — the TypeScript sidecar remains the canonical
//! deployable; this gives the refresh ALGORITHM parity in Rust.

use std::future::Future;
use std::time::Duration;

use crate::utils::SmooaiConfigError;

pub const ESO_REFRESHER_DEFAULT_INTERVAL_SECONDS: u64 = 900;

/// Writes the freshly-minted bearer token into the target Secret. Abstracted so
/// the refresh loop is unit-testable without a live cluster.
pub trait SecretWriter {
    fn patch_bearer_token(&self, token: &str) -> impl Future<Output = Result<(), SmooaiConfigError>>;
}

/// The slice of `TokenProvider` the refresher needs. The real `TokenProvider`
/// satisfies it; tests inject a fake.
pub trait TokenSource {
    fn get_access_token(&self) -> impl Future<Output = Result<String, SmooaiConfigError>>;
    fn invalidate(&self) -> impl Future<Output = ()>;
}

/// Drives the ESO bearer refresh: re-mints a fresh token and writes it to the
/// target Secret on each cycle.
pub struct EsoRefresher<T: TokenSource, W: SecretWriter> {
    token_source: T,
    secret_writer: W,
    interval: Duration,
}

impl<T: TokenSource, W: SecretWriter> EsoRefresher<T, W> {
    /// Build a refresher. `interval` defaults to 900s when zero.
    pub fn new(token_source: T, secret_writer: W, interval: Duration) -> Self {
        let interval = if interval.is_zero() {
            Duration::from_secs(ESO_REFRESHER_DEFAULT_INTERVAL_SECONDS)
        } else {
            interval
        };
        Self {
            token_source,
            secret_writer,
            interval,
        }
    }

    /// The configured re-mint interval.
    pub fn interval(&self) -> Duration {
        self.interval
    }

    /// Force a brand-new token mint + write. Invalidates first so the Secret
    /// always holds a token with (close to) a full TTL ahead — ESO must never
    /// read a token about to expire.
    pub async fn refresh_once(&self) -> Result<(), SmooaiConfigError> {
        self.token_source.invalidate().await;
        let token = self.token_source.get_access_token().await?;
        self.secret_writer.patch_bearer_token(&token).await
    }

    /// Run the refresher: an initial fail-loud mint+write, then loop on the
    /// interval until `stop` resolves. Loop failures are swallowed (the current
    /// Secret token is still valid for the rest of its TTL) and retried next
    /// tick.
    pub async fn run(&self, stop: impl Future<Output = ()>) -> Result<(), SmooaiConfigError> {
        // Initial mint+write — fail-loud.
        self.refresh_once().await?;

        let mut ticker = tokio::time::interval(self.interval);
        ticker.tick().await; // consume the immediate first tick
        tokio::pin!(stop);
        loop {
            tokio::select! {
                _ = &mut stop => return Ok(()),
                _ = ticker.tick() => {
                    let _ = self.refresh_once().await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    struct FakeTokenSource {
        tokens: Vec<String>,
        idx: RefCell<usize>,
        calls: RefCell<usize>,
        invalidations: RefCell<usize>,
    }

    impl FakeTokenSource {
        fn new(tokens: &[&str]) -> Self {
            Self {
                tokens: tokens.iter().map(|s| s.to_string()).collect(),
                idx: RefCell::new(0),
                calls: RefCell::new(0),
                invalidations: RefCell::new(0),
            }
        }
    }

    impl TokenSource for FakeTokenSource {
        async fn get_access_token(&self) -> Result<String, SmooaiConfigError> {
            *self.calls.borrow_mut() += 1;
            let i = *self.idx.borrow();
            let t = self.tokens[i.min(self.tokens.len() - 1)].clone();
            *self.idx.borrow_mut() += 1;
            Ok(t)
        }
        async fn invalidate(&self) {
            *self.invalidations.borrow_mut() += 1;
        }
    }

    struct RecordingWriter {
        written: RefCell<Vec<String>>,
        fail_on_call: usize,
        call: RefCell<usize>,
    }

    impl RecordingWriter {
        fn new(fail_on_call: usize) -> Self {
            Self {
                written: RefCell::new(Vec::new()),
                fail_on_call,
                call: RefCell::new(0),
            }
        }
    }

    impl SecretWriter for RecordingWriter {
        async fn patch_bearer_token(&self, token: &str) -> Result<(), SmooaiConfigError> {
            *self.call.borrow_mut() += 1;
            if *self.call.borrow() == self.fail_on_call {
                return Err(SmooaiConfigError::new("simulated k8s patch failure"));
            }
            self.written.borrow_mut().push(token.to_string());
            Ok(())
        }
    }

    #[tokio::test]
    async fn refresh_once_writes_fresh_token() {
        let r = EsoRefresher::new(
            FakeTokenSource::new(&["tok-1"]),
            RecordingWriter::new(0),
            Duration::ZERO,
        );
        r.refresh_once().await.unwrap();
        assert_eq!(*r.token_source.invalidations.borrow(), 1);
        assert_eq!(r.secret_writer.written.borrow().clone(), vec!["tok-1".to_string()]);
    }

    #[tokio::test]
    async fn forces_fresh_each_cycle() {
        let r = EsoRefresher::new(
            FakeTokenSource::new(&["tok-1", "tok-2"]),
            RecordingWriter::new(0),
            Duration::ZERO,
        );
        r.refresh_once().await.unwrap();
        r.refresh_once().await.unwrap();
        assert_eq!(*r.token_source.calls.borrow(), 2);
        assert_eq!(*r.token_source.invalidations.borrow(), 2);
        assert_eq!(
            r.secret_writer.written.borrow().clone(),
            vec!["tok-1".to_string(), "tok-2".to_string()]
        );
    }

    #[tokio::test]
    async fn refresh_once_propagates_write_failure() {
        let r = EsoRefresher::new(
            FakeTokenSource::new(&["tok-1"]),
            RecordingWriter::new(1),
            Duration::ZERO,
        );
        assert!(r.refresh_once().await.is_err());
    }

    #[tokio::test]
    async fn defaults_interval_when_zero() {
        let r = EsoRefresher::new(FakeTokenSource::new(&["t"]), RecordingWriter::new(0), Duration::ZERO);
        assert_eq!(
            r.interval(),
            Duration::from_secs(ESO_REFRESHER_DEFAULT_INTERVAL_SECONDS)
        );
    }
}
