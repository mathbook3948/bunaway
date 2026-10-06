// Entitlement-visibility echo service for the App Sandbox probe.
// Registers a user-domain Mach service; for each connection it reports what
// xpc_connection_copy_entitlement_value(3) returns for the peer — the same
// peer-view WebKit's XPC services use in checkEntitlements().
// Runs UNSANDBOXED without an entitlement profile; it only observes the peer's
// registered entitlements.
//
//   entsrv <log-path>
//     appends lines: "<entitlement> => <xpc description or <null>>"

#include <Foundation/Foundation.h>
#include <bsm/libbsm.h>
#include <dispatch/dispatch.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <xpc/xpc.h>

extern "C" void xpc_connection_get_audit_token(xpc_connection_t connection, audit_token_t* token);
// Private SPI: peer-view entitlement value for an XPC connection — the exact
// query WebKit's XPCServiceInitializerDelegate performs on the client app.
extern "C" xpc_object_t xpc_connection_copy_entitlement_value(xpc_connection_t connection, const char* entitlement);
// The audit-token sandbox query from XPCServiceInitializerDelegate::
// checkEntitlements (SANDBOX_FILTER_GLOBAL_NAME | SANDBOX_CHECK_NO_REPORT).
extern "C" int sandbox_check_by_audit_token(audit_token_t token, const char* operation, int type, ...);
typedef struct __SecTask* SecTaskRef;
extern "C" SecTaskRef SecTaskCreateWithAuditToken(CFAllocatorRef allocator, audit_token_t token);
extern "C" CFTypeRef SecTaskCopyValueForEntitlement(SecTaskRef task, CFStringRef entitlement, CFErrorRef* error);

static FILE* g_log;

static const char* kEntitlements[] = {
    "com.apple.security.app-sandbox",
    "com.apple.security.application-groups",
    "com.apple.security.network.client",
    "com.apple.security.network.server",
    "com.apple.security.cs.allow-jit",
    "com.apple.security.inherit",
};

static void report(xpc_connection_t peer, xpc_object_t msg) {
    const char* op = xpc_dictionary_get_string(msg, "op");
    if (!op || strcmp(op, "dump") != 0) return;
    audit_token_t at = {};
    xpc_connection_get_audit_token(peer, &at);
    fprintf(g_log, "peer audit_token pid=%d auid=%u euid=%u\n",
            audit_token_to_pid(at), audit_token_to_auid(at), audit_token_to_euid(at));
    for (const char* name : kEntitlements) {
        xpc_object_t v = xpc_connection_copy_entitlement_value(peer, name);
        char* d = v ? xpc_copy_description(v) : nullptr;
        fprintf(g_log, "%s => %s\n", name, d ? d : "<null>");
        free(d);
    }
    // Replicate WebKit's audit-token sandbox checks on the peer token.
    static const char* kMachNames[] = {
        "com.apple.nsurlsessiond",
        "com.apple.networkd",
        "com.apple.mDNSResponder",
        "com.apple.system.opendirectoryd.libinfo",
        "com.apple.CoreServices.coreservicesd",
        "com.apple.cfprefsd.daemon",
        "com.apple.usymptomsd",
    };
    for (const char* name : kMachNames) {
        int rc = sandbox_check_by_audit_token(at, "mach-lookup", 0x40000002, name);
        fprintf(g_log, "sandbox_check_by_audit_token mach-lookup %s => %d\n", name, rc);
    }
    int wrc = sandbox_check_by_audit_token(at, "file-write-data", 1, "/private/tmp");
    fprintf(g_log, "sandbox_check_by_audit_token file-write-data /private/tmp => %d\n", wrc);
    // Candidate entitlement names a shipped WebKit build might require.
    static const char* kExtraEnts[] = {
        "com.apple.developer.networking.networkextension",
        "com.apple.private.security.network.client",
        "com.apple.private.xpc.domain-extension.network.client",
        "com.apple.developer.web-browser",
        "com.apple.developer.web-browser-engine.host",
        "com.apple.security.networking.vpn.plugin",
        "com.apple.security.cs.webkit-networking-service",
    };
    for (const char* name : kExtraEnts) {
        xpc_object_t v = xpc_connection_copy_entitlement_value(peer, name);
        char* d = v ? xpc_copy_description(v) : nullptr;
        fprintf(g_log, "ent %s => %s\n", name, d ? d : "<null>");
        free(d);
    }
    // hasEntitlement(audit_token_t) variant: SecTask over the peer token.
    SecTaskRef task = SecTaskCreateWithAuditToken(kCFAllocatorDefault, at);
    if (task) {
        for (const char* name : kEntitlements) {
            CFErrorRef err = nullptr;
            CFTypeRef v = SecTaskCopyValueForEntitlement(task, (__bridge CFStringRef)[NSString stringWithUTF8String:name], &err);
            char* d = v ? (v == kCFBooleanTrue ? strdup("true") : v == kCFBooleanFalse ? strdup("false") : strdup([[(__bridge id)v description] UTF8String])) : nullptr;
            fprintf(g_log, "sectask %s => %s\n", name, d ? d : "<null>");
            free(d);
            if (v) CFRelease(v);
        }
        CFRelease(task);
    } else {
        fprintf(g_log, "sectask => <create failed>\n");
    }
    fflush(g_log);
    xpc_connection_cancel(peer);
}

int main(int argc, char** argv) {
    const char* path = argc > 1 ? argv[1] : "/tmp/entsrv.log";
    g_log = fopen(path, "a");
    if (!g_log) { perror("fopen"); return 1; }
    xpc_connection_t listener = xpc_connection_create_mach_service(
        "ai.bunaway.entsrv", dispatch_get_main_queue(), XPC_CONNECTION_MACH_SERVICE_LISTENER);
    if (!listener) { fprintf(g_log, "no listener\n"); return 1; }
    xpc_connection_set_event_handler(listener, ^(xpc_object_t peer) {
        if (xpc_get_type(peer) == XPC_TYPE_CONNECTION) {
            xpc_connection_t conn = (xpc_connection_t)peer;
            xpc_connection_set_event_handler(conn, ^(xpc_object_t msg) {
                if (xpc_get_type(msg) == XPC_TYPE_DICTIONARY) report(conn, msg);
            });
            xpc_connection_resume(conn);
        }
    });
    xpc_connection_resume(listener);
    fprintf(g_log, "entsrv ready\n");
    fflush(g_log);
    dispatch_main();
    return 0;
}
