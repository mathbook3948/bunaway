declare const self: Worker;

self.onmessage = (event: MessageEvent) => {
  if (event.data === "throw") {
    throw new Error("worker failure");
  }
  self.postMessage(event.data.double * 2);
};
