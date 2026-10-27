// Runs as plain Bun (BUN_BE_BUN) next to the compiled app: announces its pid, echoes messages,
// exits with a code on request, and stays alive when the IPC channel closes.
process.send({
  ready: process.pid,
});
process.on("message", (message) => {
  if (message === "exit") {
    process.exit(3);
  }
  process.send({
    echoed: message,
  });
});
setInterval(() => {}, 1000);
