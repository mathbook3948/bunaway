self.onmessage = (event) => {
  if (event.data === "throw") {
    throw new Error("worker failure");
  }
  self.postMessage(event.data.double * 2);
};
