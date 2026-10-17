/** Controlled Win32 bindings for a compiled adapter lifetime regression. No OS handles are created. */
export const powerCleanup = {
  sequence: 0n,
  open: new Set<bigint>(),
  closes: [] as bigint[],
  libraries: [] as string[],
  registeredCloseFailures: 0,
  rollbackCloseFailed: false,
};

export function ptr(_buffer: ArrayBufferView): number {
  return 1;
}

export function dlopen(library: string) {
  return {
    symbols: {
      GetSystemPowerStatus() {
        // The zeroed status buffer decodes to a valid battery snapshot.
        return 1;
      },
      PowerCreateRequest() {
        const handle = ++powerCleanup.sequence;
        powerCleanup.open.add(handle);
        return handle;
      },
      PowerSetRequest(handle: bigint, type: number) {
        return handle === 2n && type === 0 ? 0 : 1;
      },
      PowerClearRequest() {
        return 1;
      },
      CloseHandle(handle: bigint) {
        powerCleanup.closes.push(handle);
        if (handle === 2n && !powerCleanup.rollbackCloseFailed) {
          powerCleanup.rollbackCloseFailed = true;
          return 0;
        }
        if (handle === 1n && powerCleanup.registeredCloseFailures > 0) {
          powerCleanup.registeredCloseFailures--;
          return 0;
        }
        if (!powerCleanup.open.delete(handle)) {
          throw new Error("Already closed controlled power handle.");
        }
        return 1;
      },
    },
    close() {
      if (powerCleanup.open.size) {
        throw new Error("DLL closed before owned power handles.");
      }
      powerCleanup.libraries.push(library);
    },
  };
}
