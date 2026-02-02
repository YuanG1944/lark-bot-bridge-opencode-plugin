// src/handler/mux.ts
import type { BridgeAdapter } from '../types';

export class AdapterMux {
  private adapters = new Map<string, BridgeAdapter>();

  register(key: string, adapter: BridgeAdapter) {
    this.adapters.set(key, adapter);
  }

  get(key: string) {
    return this.adapters.get(key);
  }

  listKeys() {
    return Array.from(this.adapters.keys());
  }
}
