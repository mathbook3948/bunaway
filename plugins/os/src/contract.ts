import { z } from "zod";

const text = z.string().max(1024);
/** Read-only Windows or macOS and bundled-runtime metadata; no paths or environment variables are exposed. */
export const infoSchema = z.strictObject({
  platform: z.enum([
    "windows",
    "macos",
  ]),
  type: text,
  release: text,
  version: text,
  architecture: text,
  hostname: text,
  runtime: z.strictObject({
    name: z.literal("bun"),
    version: text,
    pid: z.number().int().positive(),
  }),
});
export const usageSchema = z.strictObject({
  pid: z.number().int().positive(),
  logicalCpuCount: z.number().int().nonnegative(),
  cpuTime: z.strictObject({
    userMicros: z.number().int().nonnegative(),
    systemMicros: z.number().int().nonnegative(),
  }),
  memory: z.strictObject({
    systemTotalBytes: z.number().int().nonnegative(),
    systemFreeBytes: z.number().int().nonnegative(),
    processResidentBytes: z.number().int().nonnegative(),
  }),
  translation: z.strictObject({
    active: z.boolean(),
    /** IMAGE_FILE_MACHINE value of the translated process; 0 when the process is not translated. */
    processMachine: z.number().int().min(0).max(65535),
    /** IMAGE_FILE_MACHINE value of the host CPU; macOS reports AMD64 (0x8664) or ARM64 (0xAA64). */
    nativeMachine: z.number().int().min(0).max(65535),
  }),
});
export const localeSchema = z.strictObject({
  locale: z.string().max(85),
  countryCode: z.string().max(3).nullable(),
  preferredLanguages: z.array(z.string().min(1).max(85)).max(128),
  systemLanguage: z.string().max(85),
});
/** Most printers one os.listPrinters call returns; a larger list is an error, not a shortened one. */
export const MAX_PRINTERS = 1024;
/** Longest printer name: MAX_PATH without the terminating NUL, which also covers server-qualified connection names. */
export const MAX_PRINTER_NAME_CHARS = 259;
const printerName = z.string().min(1).max(MAX_PRINTER_NAME_CHARS);
/** One installed printer; `isDefault` is true for at most one entry. */
export const printerSchema = z.strictObject({
  name: printerName,
  isDefault: z.boolean(),
});
export const printerListSchema = z.array(printerSchema).max(MAX_PRINTERS);
/** The default printer's name, or null when no default is set. */
export const defaultPrinterSchema = printerName.nullable();
/** Most adapters one os.listGpus call returns; a larger list is an error, not a shortened one. */
export const MAX_GPUS = 16;
/** Longest adapter name: DXGI_ADAPTER_DESC1.Description holds 128 WCHARs including the terminating NUL. */
export const MAX_GPU_NAME_CHARS = 127;
/** One graphics adapter. `vendorId` and `deviceId` are the PCI IDs DXGI reports (for example 0x10de for NVIDIA). */
export const gpuSchema = z.strictObject({
  name: z.string().max(MAX_GPU_NAME_CHARS),
  vendorId: z.number().int().min(0).max(0xffffffff),
  deviceId: z.number().int().min(0).max(0xffffffff),
  /** Video memory reserved for the adapter alone; 0 for adapters that use shared system memory. */
  dedicatedVideoMemoryBytes: z.number().int().nonnegative(),
  /** True for a software renderer such as the Microsoft Basic Render Driver. */
  software: z.boolean(),
});
export const gpuListSchema = z.array(gpuSchema).max(MAX_GPUS);
/** System sound played by os.beep; defaults to the plain default beep. macOS has one alert sound and plays it for every kind. */
export const beepInputSchema = z.strictObject({
  kind: z
    .enum([
      "default",
      "info",
      "warning",
      "error",
    ])
    .default("default"),
});
/** Caller input for os.beep; `kind` may be omitted and then defaults to "default". */
export type OSBeepInput = z.input<typeof beepInputSchema>;
/** OS and runtime snapshot returned by os.info. */
export type OSInfo = z.infer<typeof infoSchema>;
/** User locale, ordered display languages and system UI language. */
export type OSLocale = z.infer<typeof localeSchema>;

/** Installed printer as listed by os.listPrinters. */
export type OSPrinter = z.infer<typeof printerSchema>;

/** Graphics adapter as listed by os.listGpus. */
export type OSGpu = z.infer<typeof gpuSchema>;

/** Process CPU time, memory and architecture translation snapshot. */
export type OSUsage = z.infer<typeof usageSchema>;
/**
 * What the os operations call on the per-plugin instance. Operations are typed by this
 * interface, never by a platform module, so a new platform implements the contract instead of
 * matching another platform's shape by accident.
 */
export interface OSInstance {
  info(): OSInfo;
  usage(): OSUsage;
  locale(): OSLocale;
  beep(kind: NonNullable<OSBeepInput["kind"]>): null;
  listPrinters(): OSPrinter[];
  getDefaultPrinter(): string | null;
  listGpus(): OSGpu[];
  dispose(): void;
}
