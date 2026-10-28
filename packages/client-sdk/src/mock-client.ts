import {
  type CommandMap,
  type EventMap,
  PROTOCOL_VERSION,
  SDK_READY_FEATURE,
} from "@bunaway/protocol";
import type { Client, ClientFactory } from "./index.ts";
import {
  createMockTransport,
  type MockHandlers,
  type MockTransport,
} from "./mock-transport.ts";

/** Options for `createMockClient`. */
export type MockClientOptions<C extends CommandMap> = {
  /** Answers each invoked command; a command without a handler fails with `UNSUPPORTED`. */
  handlers: MockHandlers<C>;
};

/** A client wired to an in-memory host, plus the way to push events into it. */
export type MockClient<
  C extends CommandMap = CommandMap,
  E extends EventMap = EventMap,
> = {
  /** A real `createClient` session; `client.close()` also closes the mock host. */
  client: Client<C, E>;
  /** Delivers an event to every active subscription for `event`; see `MockTransport.emit`. */
  emit: MockTransport<E>["emit"];
};

/** Builds the mock host and a client for it. Takes `factory` so this file does not import the client module's values. */
export function mockClient<C extends CommandMap, E extends EventMap>(
  factory: ClientFactory,
  options: MockClientOptions<C>,
): MockClient<C, E> {
  const transport = createMockTransport<C, E>({
    handlers: options.handlers,
  });
  return {
    client: factory<C, E>({
      transport,
      hello: {
        kind: "hello",
        protocol: PROTOCOL_VERSION,
        features: [
          SDK_READY_FEATURE,
        ],
        buildId: "bunaway-mock-client",
      },
    }),
    emit: (event, payload) => transport.emit(event, payload),
  };
}
