import type { ChannelId, PackageAdapter } from "./contract.ts";

// Channel adapters register here. The CLI resolves adapters through this map
// so adding a channel never edits shared entry-point code — a new adapter is a
// new file plus a registration call.
const adapters = new Map<ChannelId, PackageAdapter>();

export function registerAdapter(adapter: PackageAdapter): void {
  if (adapters.has(adapter.channel)) {
    throw new Error(`Duplicate packaging adapter for channel ${adapter.channel}.`);
  }
  adapters.set(adapter.channel, adapter);
}

export function adapterFor(channel: ChannelId): PackageAdapter | undefined {
  return adapters.get(channel);
}

export function registeredChannels(): ChannelId[] {
  return [...adapters.keys()].sort();
}
