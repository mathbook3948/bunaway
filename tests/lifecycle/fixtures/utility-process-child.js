// Runs as plain Bun (BUN_BE_BUN) next to the compiled app: announces its pid, echoes messages,
// exits with a code on request, and ends with its IPC channel unless the app asks it to linger.
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
process.on("disconnect", () => {
  if (process.env.BUNAWAY_FIXTURE_LINGER !== "1") {
    process.exit(0);
  }
});
setInterval(() => {}, 1000);
