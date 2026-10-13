import assert from "node:assert/strict";
import { type AppDefinition, defineApp } from "@bunaway/backend";
import { network, networkPlugin } from "@bunaway/plugin-network";
import { validateValue } from "@bunaway/protocol";

/** App commands deliberately retain the calling view's authority through Core. */
export function defineNetworkFixture(http: string, ws: string) {
  const peers = new Set<string>();
  return defineApp({
    modules: [],
    plugins: [
      networkPlugin,
      {
        name: "backend-network-check",
        version: "1",
        async setup() {
          const result = await network.request({
            url: `${http}/text`,
          });
          assert.equal(
            Buffer.from(result.bodyBase64, "base64").toString(),
            "한글 😀",
          );
          // Backend only has the HTTP grant. A view grant cannot elevate setup.
          await assert.rejects(
            network.exchange({
              url: `${ws}/socket`,
              messages: [],
              receiveCount: 1,
            }),
            {
              code: "PERMISSION_DENIED",
            },
          );
        },
      },
    ],
    commands: {
      "test.config": {
        input: {
          const: null,
        },
        output: {
          type: "object",
        },
        run: async () => ({
          http,
          ws,
        }),
      },
      "test.ready": {
        input: {
          type: "string",
        },
        output: {
          const: null,
        },
        async run(name) {
          assert.equal(typeof name, "string");
          if (typeof name !== "string") {
            throw new Error("Invalid peer name");
          }
          peers.add(name);
          return null;
        },
      },
      "test.peers": {
        input: {
          const: null,
        },
        output: {
          const: null,
        },
        async run(_input, context) {
          while (peers.size !== 2) {
            assert(!context.signal.aborted, "Peer wait cancelled");
            await Bun.sleep(5);
          }
          return null;
        },
      },
      "test.stats": {
        input: {
          const: null,
        },
        output: {
          type: "object",
        },
        async run() {
          return validateValue({}, await (await fetch(`${http}/stats`)).json());
        },
      },
      "test.inheritedHttp": {
        input: {
          const: null,
        },
        output: {
          type: "object",
        },
        run: () =>
          network.request({
            url: `${http}/text`,
          }),
      },
      "test.inheritedWs": {
        input: {
          const: null,
        },
        output: {
          type: "object",
        },
        run: () =>
          network.exchange({
            url: `${ws}/socket`,
            messages: [
              "inherited",
            ],
            receiveCount: 1,
          }),
      },
      "test.echo": {
        input: {
          type: "string",
        },
        output: {
          type: "string",
        },
        async run(value) {
          assert(typeof value === "string");
          return value;
        },
      },
      "test.report": {
        input: {},
        output: {
          const: null,
        },
        async run(report) {
          assert(process.env.TMPDIR);
          await Bun.write(
            `${process.env.TMPDIR}/report.json`,
            JSON.stringify(report),
          );
          return null;
        },
      },
    } satisfies NonNullable<AppDefinition["commands"]>,
  });
}
