import { createClient } from "@bunaway/client";
import { PROBE_NAMES } from "../web-api-probe-report.ts";

/** Each probe gets this long; a hung API is reported as an error instead of hanging the test. */
const PROBE_TIMEOUT_MS = 8000;

const supported = (detail = "") => ({
  status: "supported",
  detail,
});
const unsupported = (detail = "") => ({
  status: "unsupported",
  detail,
});

/** Resolve with the first message a port or channel receives. */
function nextMessage(target) {
  return new Promise((resolve) => {
    target.addEventListener("message", (event) => resolve(event.data), {
      once: true,
    });
  });
}

async function probeWorker() {
  if (typeof Worker === "undefined") {
    return unsupported();
  }
  const worker = new Worker("/probe-worker.js");
  try {
    const reply = nextMessage(worker);
    worker.postMessage("ping");
    return (await reply) === "ping" ? supported() : unsupported("no echo");
  } finally {
    worker.terminate();
  }
}

async function probeSharedWorker() {
  if (typeof SharedWorker === "undefined") {
    return unsupported();
  }
  const worker = new SharedWorker("/probe-worker.js");
  const reply = nextMessage(worker.port);
  worker.port.start();
  worker.port.postMessage("ping");
  return (await reply) === "ping" ? supported() : unsupported("no echo");
}

async function probeBroadcastChannel() {
  if (typeof BroadcastChannel === "undefined") {
    return unsupported();
  }
  const sender = new BroadcastChannel("probe");
  const receiver = new BroadcastChannel("probe");
  try {
    const reply = nextMessage(receiver);
    sender.postMessage("ping");
    return (await reply) === "ping" ? supported() : unsupported("no message");
  } finally {
    sender.close();
    receiver.close();
  }
}

/** Constructing a socket is the check; no server listens, so the connection itself fails. */
async function probeWebSocket() {
  if (typeof WebSocket === "undefined") {
    return unsupported();
  }
  const socket = new WebSocket("ws://127.0.0.1:1/");
  await new Promise((resolve) => {
    socket.addEventListener("error", () => resolve(), {
      once: true,
    });
    socket.addEventListener("close", () => resolve(), {
      once: true,
    });
  });
  return supported("constructed, connection refused");
}

function probeRtcPeerConnection() {
  if (typeof RTCPeerConnection === "undefined") {
    return unsupported();
  }
  const connection = new RTCPeerConnection({
    iceServers: [],
  });
  connection.close();
  return supported();
}

/** Two peers on this page exchange a message over a data channel using host candidates only. */
async function probeRtcDataChannelLoopback() {
  if (typeof RTCPeerConnection === "undefined") {
    return unsupported();
  }
  const first = new RTCPeerConnection({
    iceServers: [],
  });
  const second = new RTCPeerConnection({
    iceServers: [],
  });
  try {
    first.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        void second.addIceCandidate(event.candidate);
      }
    });
    second.addEventListener("icecandidate", (event) => {
      if (event.candidate) {
        void first.addIceCandidate(event.candidate);
      }
    });
    const received = new Promise((resolve) => {
      second.addEventListener("datachannel", (event) => {
        event.channel.addEventListener("message", (message) =>
          resolve(message.data),
        );
      });
    });
    const channel = first.createDataChannel("probe");
    channel.addEventListener("open", () => channel.send("ping"));
    await first.setLocalDescription(await first.createOffer());
    await second.setRemoteDescription(first.localDescription);
    await second.setLocalDescription(await second.createAnswer());
    await first.setRemoteDescription(second.localDescription);
    return (await received) === "ping"
      ? supported()
      : unsupported("wrong message");
  } finally {
    first.close();
    second.close();
  }
}

/** The renderer string tells a software rasterizer from a GPU; it is recorded, not judged. */
function probeWebGl(kind) {
  const context = document.createElement("canvas").getContext(kind);
  if (!context) {
    return unsupported("no context");
  }
  const info = context.getExtension("WEBGL_debug_renderer_info");
  const renderer = info
    ? context.getParameter(info.UNMASKED_RENDERER_WEBGL)
    : context.getParameter(context.RENDERER);
  return supported(String(renderer));
}

async function probeServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return unsupported();
  }
  const registration = await navigator.serviceWorker.register("/probe-sw.js");
  const ready = await navigator.serviceWorker.ready;
  await registration.unregister();
  return supported(ready.scope);
}

async function probeMediaDevices() {
  if (!navigator.mediaDevices) {
    return unsupported();
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  return supported(`${devices.length} devices`);
}

/** A runner without a camera rejects; what matters is the error name the engine gives. */
async function probeGetUserMedia() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return unsupported();
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
    });
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return supported("camera available");
  } catch (error) {
    return {
      status: "error",
      detail: String(error.name),
    };
  }
}

const probes = {
  worker: probeWorker,
  sharedWorker: probeSharedWorker,
  broadcastChannel: probeBroadcastChannel,
  webSocket: probeWebSocket,
  rtcPeerConnection: probeRtcPeerConnection,
  webgl: () => probeWebGl("webgl"),
  webgl2: () => probeWebGl("webgl2"),
  rtcDataChannelLoopback: probeRtcDataChannelLoopback,
  serviceWorker: probeServiceWorker,
  mediaDevices: probeMediaDevices,
  getUserMedia: probeGetUserMedia,
};

/** Run one probe, turning a throw or a hang into an `error` outcome. */
async function runProbe(probe) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          status: "error",
          detail: "timeout",
        }),
      PROBE_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([
      Promise.resolve().then(probe),
      timeout,
    ]);
  } catch (error) {
    return {
      status: "error",
      detail: `${error?.name}: ${error?.message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const client = createClient();
await client.ready;
const outcomes = {};
for (const name of PROBE_NAMES) {
  outcomes[name] = await runProbe(probes[name]);
}
await client.invoke("test.record", {
  report: {
    userAgent: navigator.userAgent,
    origin: location.origin,
    probes: outcomes,
  },
});
await client.invoke("test.finish", null).catch(() => {});
