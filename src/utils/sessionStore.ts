/**
 * Per-session browser storage (IndexedDB) with URL hash-based session IDs.
 * Similar to Perfetto: each user gets a unique session; state is stored client-side.
 */

const DB_NAME = 'GanttSketchSessionDB';
const DB_VERSION = 1;
const STORE_NAME = 'sessions';
const HASH_PREFIX = '#!/viewer';
const SESSION_PARAM = 'session';

export interface SessionLLMConfig {
  provider?: 'openai' | 'anthropic' | 'ollama' | 'deepseek' | 'zhipu' | 'qwen' | 'custom';
  apiKey?: string;
  apiEndpoint?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  useMaxCompletionParam?: boolean;
}

export interface SessionState {
  localTraceText?: string;
  localTraceName?: string;
  dataMapping?: unknown;
  ganttConfig?: unknown;
  tracksConfig?: unknown;
  widgetConfig?: unknown;
  widgets?: unknown[];
  messages?: Array<{ role: string; content: string }>;
  llmConfig?: SessionLLMConfig;
  savedAt?: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });
}

/**
 * Parse session ID from current URL hash.
 * Expects format: #!/viewer?session=<uuid>
 * Returns null if no valid session ID is present.
 */
export function parseSessionIdFromHash(): string | null {
  if (typeof window === 'undefined') return null;
  const hash = window.location.hash;
  if (!hash.startsWith(HASH_PREFIX)) return null;
  const params = new URLSearchParams(hash.slice(HASH_PREFIX.length));
  const session = params.get(SESSION_PARAM);
  if (session && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(session)) {
    return session;
  }
  return null;
}

/**
 * Get or create session ID. If none in hash, generate new UUID and redirect.
 * Call this before React renders (e.g. in index.tsx).
 * Returns the session ID (either parsed or newly created).
 */
export function ensureSessionIdInHash(): string {
  if (typeof window === 'undefined') {
    return '00000000-0000-0000-0000-000000000000';
  }
  const existing = parseSessionIdFromHash();
  if (existing) return existing;
  const newId = crypto.randomUUID();
  const newHash = `${HASH_PREFIX}?${SESSION_PARAM}=${newId}`;
  window.location.replace(window.location.pathname + window.location.search + newHash);
  return newId;
}

/**
 * Get session ID from hash without redirecting.
 * Use when React has already mounted and hash is guaranteed to exist.
 */
export function getSessionId(): string {
  const id = parseSessionIdFromHash();
  if (id) return id;
  return crypto.randomUUID();
}

/**
 * Save session state to IndexedDB.
 */
export async function saveSessionState(id: string, state: SessionState): Promise<void> {
  const db = await openDB();
  const record = { id, ...state, savedAt: Date.now() };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(record);
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    request.onsuccess = () => {
      db.close();
      resolve();
    };
  });
}

/**
 * Load session state from IndexedDB.
 * Returns null if not found.
 */
export async function loadSessionState(id: string): Promise<SessionState | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    request.onsuccess = () => {
      db.close();
      const record = request.result;
      if (!record) {
        resolve(null);
        return;
      }
      const { id: _, savedAt, ...state } = record;
      resolve({ ...state, savedAt } as SessionState);
    };
  });
}

/**
 * Delete a session from IndexedDB.
 */
export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(id);
    request.onerror = () => {
      db.close();
      reject(request.error);
    };
    request.onsuccess = () => {
      db.close();
      resolve();
    };
  });
}
