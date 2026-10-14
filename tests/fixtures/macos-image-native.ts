import image from "@bunaway/plugin-image/native/macos";
import { verifyMacosImage } from "./macos-image.ts";

const report = await verifyMacosImage(image);
console.log(JSON.stringify(report));
if (process.argv[2]) {
  await Bun.write(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
}
