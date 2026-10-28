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
/** Most processes one os.listAppProcesses call returns; a larger tree is an error, not a shortened one. */
export const MAX_APP_PROCESSES = 256;
/**
 * One process of the app's process tree. Windows runs the host and the backend in one Bun process, so
 * `app` is that process; `webview2` is a WebView2 browser, renderer, GPU or utility process (and its
 * descendants); `other` is any other descendant, such as a child the app started.
 */
export const appProcessKindSchema = z.enum([
  "app",
  "webview2",
  "other",
]);
/** Memory and CPU time of a process that could be opened for limited queries. */
export const appProcessMetricsSchema = z.strictObject({
  workingSetBytes: z.number().int().nonnegative(),
  cpuTime: z.strictObject({
    userMicros: z.number().int().nonnegative(),
    systemMicros: z.number().int().nonnegative(),
  }),
});
export const appProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  parentPid: z.number().int().nonnegative(),
  kind: appProcessKindSchema,
  /** Null when the process cannot be opened for limited queries (for example a protected process). */
  metrics: appProcessMetricsSchema.nullable(),
});
export const appProcessListSchema = z
  .array(appProcessSchema)
  .max(MAX_APP_PROCESSES);
/** Device class os.getMediaAccessStatus reads the OS privacy setting for. */
export const mediaTypeSchema = z.enum([
  "camera",
  "microphone",
]);
export const mediaAccessInputSchema = z.strictObject({
  mediaType: mediaTypeSchema,
});
/**
 * OS privacy setting for a device class, using the value set of Electron's
 * `systemPreferences.getMediaAccessStatus`. Windows reports `granted` (setting on), `denied`
 * (user turned it off), `restricted` (the device-wide setting is off), `not-determined` (no
 * setting stored) and `unknown` (unreadable or unexpected value).
 */
export const mediaAccessStatusSchema = z.enum([
  "granted",
  "denied",
  "not-determined",
  "restricted",
  "unknown",
]);
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

/** One process of the app's process tree as listed by os.listAppProcesses. */
export type OSAppProcess = z.infer<typeof appProcessSchema>;

/** Input of os.getMediaAccessStatus. */
export type OSMediaAccessInput = z.infer<typeof mediaAccessInputSchema>;

/** Device class os.getMediaAccessStatus reads. */
export type OSMediaType = z.infer<typeof mediaTypeSchema>;

/** Result of os.getMediaAccessStatus. */
export type OSMediaAccessStatus = z.infer<typeof mediaAccessStatusSchema>;

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
  listAppProcesses(): OSAppProcess[];
  getMediaAccessStatus(mediaType: OSMediaType): OSMediaAccessStatus;
  dispose(): void;
}
