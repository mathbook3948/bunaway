import {
  type DownloadResource,
  Downloads,
} from "#native/windows/bun/downloads";

// This dedicated fixture worker wraps only the real operation for its controlled transfer.
// Production UI workers and other fixture processes keep their original cancellation behavior.
const offer = Downloads.prototype.offer;
Downloads.prototype.offer = function (
  resource: DownloadResource,
  source: string,
) {
  if (!resource.read().url.endsWith("/cleanup-failure.bin")) {
    return offer.call(this, resource, source);
  }
  let failures = 20;
  return offer.call(
    this,
    {
      ...resource,
      cancel() {
        if (failures-- > 0) {
          throw new Error(
            "Injected transient native Cancel failure for the closing owner",
          );
        }
        resource.cancel();
      },
    },
    source,
  );
};

await import("#native/windows/bun/ui");
