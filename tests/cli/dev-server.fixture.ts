const [port, mode, childPort] = process.argv.slice(2);
if (!port || !mode) throw new Error("Expected port and mode.");
const started = Date.now();
if (childPort) {
  Bun.spawn(
    [
      process.execPath,
      "-e",
      `Bun.serve({hostname:'127.0.0.1',port:${Number(childPort)},fetch:()=>new Response('descendant')});`,
    ],
    { stdin: "ignore", stdout: "inherit", stderr: "inherit" },
  );
}
if (mode === "exit" || mode === "exit-tree") {
  await Bun.sleep(150);
  process.exit(7);
}
Bun.serve({
  hostname: "127.0.0.1",
  port: Number(port),
  fetch() {
    if (mode === "timeout" || (mode === "delayed" && Date.now() - started < 300)) {
      return new Response("not ready", { status: 503 });
    }
    if (mode === "redirect") return Response.redirect(`http://127.0.0.1:${port}/elsewhere`);
    return new Response("ready");
  },
});
