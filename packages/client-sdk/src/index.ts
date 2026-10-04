import type {
  AsyncDispose,
  CancellationSignal,
  Capabilities,
  CommandMap,
  EventMap,
  FrameworkCommands,
  Hello,
  Message,
  NegotiatedProtocol,
  Transport,
  WireError,
} from "@bunaway/protocol";

export type InvokeOptions = { signal?: CancellationSignal; deadline?: number };
export type ListenOptions = { signal?: CancellationSignal; onError: (error: WireError) => void };
export type EventDelivery<T> = Omit<Extract<Message, { kind: "event" }>, "payload"> & {
  payload: T;
};

export interface Client<C extends CommandMap = CommandMap, E extends EventMap = EventMap> {
  readonly ready: Promise<NegotiatedProtocol>;
  invoke<K extends keyof C & string>(
    command: K,
    payload: C[K]["input"],
    options?: InvokeOptions,
  ): Promise<C[K]["output"]>;
  listen<K extends keyof E & string>(
    event: K,
    listener: (event: EventDelivery<E[K]>) => void,
    options: ListenOptions,
  ): Promise<AsyncDispose>;
  capabilities(): Promise<Capabilities>;
  close(): Promise<void>;
}

// Runtime implementation is the client-sdk parallel workstream.
export type ClientFactory = <
  C extends CommandMap = CommandMap,
  E extends EventMap = EventMap,
>(options: {
  transport: Transport;
  hello: Hello;
}) => Client<C & FrameworkCommands, E>;
