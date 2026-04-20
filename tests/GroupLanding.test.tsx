import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { submitJoin, submitCreate } from '../src/views/GroupLanding';

// ---------------------------------------------------------------
// We run vitest under `environment: 'node'`, so this file does not
// render React components -- instead it drives the exported pure
// handlers that encapsulate the Join/Create flows. The handlers
// accept an injectable `fetch`, `reload`, and `storage.set`, which
// is exactly how the component uses them. This keeps the tests
// dependency-free (no jsdom, no @testing-library) while still
// covering the behaviours the spec calls out: localStorage is set
// on success, reload is called on success, and the 404 error path
// surfaces the right user-facing message.
// ---------------------------------------------------------------

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

function installWindow() {
  const g = globalThis as unknown as { window?: { localStorage: MemoryStorage } };
  g.window = { localStorage: new MemoryStorage() };
  return () => delete (globalThis as { window?: unknown }).window;
}

function mockResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('GroupLanding -- submitJoin', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installWindow();
  });

  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it('join flow: user types a code, resolve returns 200, localStorage is set and reload is called', async () => {
    // Arrange: simulate the component's behaviour -- the user types
    // "abc123" into the input, which the component uppercases before
    // handing to submitJoin. Here we pass the already-uppercased code
    // because the normaliser also upper-cases defensively.
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(200, { id: 'tenant-uuid', code: 'ABC123' })
    );
    const reload = vi.fn();
    const set = vi.fn();

    // Act
    const res = await submitJoin({
      code: 'ABC123',
      fetch: fetchMock,
      reload,
      storage: { set },
    });

    // Assert
    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/tenants/resolve?code=ABC123');
    expect(set).toHaveBeenCalledWith('ABC123');
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('join flow: resolve returns 404 surfaces "No group with that code" and does NOT set localStorage or reload', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(404, { error: 'not found' }));
    const reload = vi.fn();
    const set = vi.fn();

    const res = await submitJoin({
      code: 'NOPE00',
      fetch: fetchMock,
      reload,
      storage: { set },
    });

    expect(res.ok).toBe(false);
    expect(res.error).toBe('No group with that code');
    expect(set).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('join flow: rejects empty code before hitting the network', async () => {
    const fetchMock = vi.fn();
    const res = await submitJoin({ code: '', fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('join flow: rejects a code that is not 6 chars before hitting the network', async () => {
    const fetchMock = vi.fn();
    const res = await submitJoin({
      code: 'ABC',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/6 characters/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('join flow: network/fetch rejection surfaces a retry-friendly error', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
    const res = await submitJoin({
      code: 'ABC123',
      fetch: fetchMock,
      reload: () => {
        throw new Error('reload should NOT be called');
      },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/network/i);
  });

  it('join flow: non-200 / non-404 (e.g. 500) surfaces a generic retry message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(500, { error: 'oops' }));
    const res = await submitJoin({ code: 'ABC123', fetch: fetchMock });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/try again/i);
  });

  it('join flow: normalises lowercase input before calling resolve', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(200, {}));
    await submitJoin({
      code: 'abc123',
      fetch: fetchMock,
      reload: () => {},
      storage: { set: () => {} },
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/tenants/resolve?code=ABC123');
  });
});

describe('GroupLanding -- submitCreate', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installWindow();
  });

  afterEach(() => {
    restore();
    vi.restoreAllMocks();
  });

  it('create flow: POSTs the expected payload and returns the new code on 201', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(201, { id: 'tenant-uuid', code: 'NEW123' })
    );
    const res = await submitCreate({
      groupName: 'Friday Night',
      adminName: 'Alice',
      username: 'alice',
      password: 'hunter2',
      fetch: fetchMock,
    });

    expect(res.ok).toBe(true);
    expect(res.code).toBe('NEW123');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/tenants');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'Friday Night',
      adminName: 'Alice',
      username: 'alice',
      password: 'hunter2',
    });
  });

  it('create flow: rejects when required fields are missing', async () => {
    const fetchMock = vi.fn();
    const res = await submitCreate({
      groupName: '',
      adminName: 'Alice',
      username: 'alice',
      password: 'hunter2',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(res.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('create flow: surfaces server error message on non-201', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse(409, { error: 'Username already exists' })
    );
    const res = await submitCreate({
      groupName: 'Friday Night',
      adminName: 'Alice',
      username: 'alice',
      password: 'hunter2',
      fetch: fetchMock,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Username already exists');
  });

  it('create flow: handles a 201 with missing code field gracefully', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse(201, {}));
    const res = await submitCreate({
      groupName: 'Friday Night',
      adminName: 'Alice',
      username: 'alice',
      password: 'hunter2',
      fetch: fetchMock,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no code/i);
  });
});
