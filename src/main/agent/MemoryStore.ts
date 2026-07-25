import type { AgentMemory } from '../../shared/types';

export class MemoryStore {
  private memories: AgentMemory[] = [];

  add(content: string, category: AgentMemory['category'], importance: number): AgentMemory {
    const memory: AgentMemory = {
      id: `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      category,
      importance: Math.max(1, Math.min(10, importance)),
      createdAt: new Date().toISOString(),
      lastAccessedAt: new Date().toISOString()
    };
    this.memories.push(memory);
    this.prune();
    return memory;
  }

  search(query: string): AgentMemory[] {
    const lower = query.toLowerCase();
    return this.memories
      .filter((m) => m.content.toLowerCase().includes(lower))
      .sort((a, b) => b.importance - a.importance)
      .slice(0, 10);
  }

  getRelevant(maxCount: number = 10): AgentMemory[] {
    return [...this.memories]
      .sort((a, b) => b.importance - a.importance)
      .slice(0, maxCount);
  }

  getAll(): AgentMemory[] {
    return [...this.memories];
  }

  delete(id: string): boolean {
    const index = this.memories.findIndex((m) => m.id === id);
    if (index >= 0) {
      this.memories.splice(index, 1);
      return true;
    }
    return false;
  }

  clear(): void {
    this.memories = [];
  }

  private prune(): void {
    if (this.memories.length > 100) {
      this.memories.sort((a, b) => b.importance - a.importance);
      this.memories = this.memories.slice(0, 100);
    }
  }

  toJSON(): AgentMemory[] {
    return this.memories;
  }

  fromJSON(data: AgentMemory[]): void {
    this.memories = data;
  }
}
