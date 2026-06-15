// 内存存储实现（用于开发和测试，没有 D1/KV 时）
// 注意：Workers 每次请求可能会创建新的实例，所以这不是持久化的

export class MemoryStore {
  private data: Map<string, any> = new Map();
  private sessions: Map<string, any> = new Map();
  private cache: Map<string, { value: any; expires: number }> = new Map();

  // KV-like operations
  async get(key: string): Promise<any> {
    // 检查缓存是否过期
    const cached = this.cache.get(key);
    if (cached) {
      if (cached.expires > Date.now()) {
        return cached.value;
      }
      this.cache.delete(key);
    }
    return this.data.get(key) || null;
  }

  async put(key: string, value: any, options?: { expirationTtl?: number }): Promise<void> {
    if (options?.expirationTtl) {
      this.cache.set(key, {
        value,
        expires: Date.now() + options.expirationTtl * 1000,
      });
    } else {
      this.data.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
    this.cache.delete(key);
  }

  // Session operations
  async getSession(sessionId: string): Promise<any> {
    return this.sessions.get(sessionId) || null;
  }

  async setSession(sessionId: string, data: any, ttl: number = 3600): Promise<void> {
    this.sessions.set(sessionId, {
      ...data,
      _expires: Date.now() + ttl * 1000,
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  // Data operations (simulating D1)
  private tables: Map<string, any[]> = new Map();

  async query(table: string, filters?: Record<string, any>): Promise<any[]> {
    let results = this.tables.get(table) || [];
    if (filters) {
      results = results.filter((item) => {
        return Object.entries(filters).every(([key, value]) => item[key] === value);
      });
    }
    return results;
  }

  async insert(table: string, data: any): Promise<void> {
    if (!this.tables.has(table)) {
      this.tables.set(table, []);
    }
    this.tables.get(table)!.push({
      ...data,
      id: data.id || crypto.randomUUID(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  async update(table: string, id: string, data: any): Promise<void> {
    const items = this.tables.get(table) || [];
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) {
      items[index] = { ...items[index], ...data, updated_at: new Date().toISOString() };
    }
  }

  async deleteRecord(table: string, id: string): Promise<void> {
    const items = this.tables.get(table) || [];
    const index = items.findIndex((item) => item.id === id);
    if (index >= 0) {
      items.splice(index, 1);
    }
  }
}

// 单例实例
export const memoryStore = new MemoryStore();
