// Minimal child for spawn-inheritance checks: reports whether Seatbelt
// considers it sandboxed (inheritance actually applied) plus its HOME view.
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

extern int sandbox_check(pid_t pid, const char* operation, int type, ...);

int main(int argc, char** argv) {
    int denied = sandbox_check(getpid(), "file-write-data", 1, "/");
    const char* home = getenv("HOME");
    printf("child-ok %s sandboxed=%d home=%s\n",
        argc > 1 ? argv[1] : "", denied, home ? home : "");
    fflush(stdout);
    return 0;
}
