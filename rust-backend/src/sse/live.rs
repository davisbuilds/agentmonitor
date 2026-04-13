use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use chrono::Utc;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::{Mutex, broadcast};

const DEFAULT_HISTORY_LIMIT: usize = 500;
const DEFAULT_CHANNEL_CAPACITY: usize = 256;

#[derive(Debug, Clone, Serialize)]
pub struct LiveSseEvent {
    pub id: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub payload: Value,
    pub timestamp: String,
}

#[derive(Debug, Clone, Default)]
pub struct LiveSubscribeOptions {
    pub session_id: Option<String>,
    pub since_id: Option<u64>,
}

#[derive(Debug)]
struct LiveHistoryState {
    events: Vec<LiveSseEvent>,
    next_event_id: u64,
}

#[derive(Clone)]
pub struct LiveSseHub {
    tx: broadcast::Sender<LiveSseEvent>,
    history: Arc<Mutex<LiveHistoryState>>,
    client_count: Arc<AtomicUsize>,
    max_clients: usize,
    history_limit: usize,
}

impl LiveSseHub {
    pub fn new(max_clients: usize) -> Self {
        let (tx, _) = broadcast::channel(DEFAULT_CHANNEL_CAPACITY);
        Self {
            tx,
            history: Arc::new(Mutex::new(LiveHistoryState {
                events: Vec::new(),
                next_event_id: 1,
            })),
            client_count: Arc::new(AtomicUsize::new(0)),
            max_clients,
            history_limit: DEFAULT_HISTORY_LIMIT,
        }
    }

    pub async fn subscribe(&self, options: LiveSubscribeOptions) -> Option<LiveSseClient> {
        if self
            .client_count
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                (current < self.max_clients).then_some(current + 1)
            })
            .is_err()
        {
            return None;
        }

        let mut history = self.history.lock().await;
        let replay = history
            .events
            .iter()
            .filter(|event| options.since_id.is_some_and(|since_id| event.id > since_id))
            .filter(|event| matches_session_filter(event, options.session_id.as_deref()))
            .cloned()
            .collect::<Vec<_>>();
        let latest_event_id = history.events.last().map(|event| event.id);
        let connected = LiveSseEvent {
            id: next_event_id(&mut history),
            event_type: "connected".to_string(),
            payload: serde_json::json!({
                "replayed": replay.len(),
                "latest_event_id": latest_event_id,
            }),
            timestamp: Utc::now().to_rfc3339(),
        };
        let rx = self.tx.subscribe();
        drop(history);

        Some(LiveSseClient {
            rx: Some(rx),
            replay: Some(replay),
            connected: Some(connected),
            session_id: options.session_id,
            count: Arc::clone(&self.client_count),
            moved_to_guard: false,
        })
    }

    pub async fn broadcast(&self, event_type: &str, payload: Value) {
        let event = {
            let mut history = self.history.lock().await;
            let event = LiveSseEvent {
                id: next_event_id(&mut history),
                event_type: event_type.to_string(),
                payload,
                timestamp: Utc::now().to_rfc3339(),
            };
            history.events.push(event.clone());
            if history.events.len() > self.history_limit {
                let trim = history.events.len() - self.history_limit;
                history.events.drain(0..trim);
            }
            event
        };

        let _ = self.tx.send(event);
    }

    pub fn client_count(&self) -> usize {
        self.client_count.load(Ordering::Relaxed)
    }
}

fn next_event_id(history: &mut LiveHistoryState) -> u64 {
    let id = history.next_event_id;
    history.next_event_id += 1;
    id
}

fn matches_session_filter(event: &LiveSseEvent, session_id: Option<&str>) -> bool {
    match session_id {
        None => true,
        Some(session_id) => event
            .payload
            .get("session_id")
            .and_then(Value::as_str)
            .is_some_and(|candidate| candidate == session_id),
    }
}

pub struct LiveSseClient {
    rx: Option<broadcast::Receiver<LiveSseEvent>>,
    replay: Option<Vec<LiveSseEvent>>,
    connected: Option<LiveSseEvent>,
    session_id: Option<String>,
    count: Arc<AtomicUsize>,
    moved_to_guard: bool,
}

impl LiveSseClient {
    pub fn into_parts(
        mut self,
    ) -> (
        broadcast::Receiver<LiveSseEvent>,
        Vec<LiveSseEvent>,
        LiveSseEvent,
        Option<String>,
        LiveSseDropGuard,
    ) {
        self.moved_to_guard = true;
        let guard = LiveSseDropGuard {
            count: Arc::clone(&self.count),
        };
        let rx = self.rx.take().expect("live SSE receiver");
        let replay = self.replay.take().expect("live SSE replay");
        let connected = self.connected.take().expect("live SSE connected event");
        let session_id = self.session_id.take();
        (rx, replay, connected, session_id, guard)
    }
}

impl Drop for LiveSseClient {
    fn drop(&mut self) {
        if !self.moved_to_guard {
            self.count.fetch_sub(1, Ordering::Release);
        }
    }
}

pub struct LiveSseDropGuard {
    count: Arc<AtomicUsize>,
}

impl Drop for LiveSseDropGuard {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::Release);
    }
}
