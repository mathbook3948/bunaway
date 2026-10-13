import imagePlugin from "@bunaway/plugin-image/native/macos";
import { verifyMacosImage } from "./macos-image.ts";

const factory = imagePlugin.nativePlatforms?.macos?.create;
if (!factory) {
  throw new Error("Packaged macOS image adapter is missing.");
}
const report = await verifyMacosImage(factory);
console.log(JSON.stringify(report));
if (process.argv[2]) {
  await Bun.write(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
}
