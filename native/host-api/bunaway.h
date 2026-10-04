#ifndef BUNAWAY_HOST_API_H
#define BUNAWAY_HOST_API_H

/* Historical in-process ABI draft. The current bundled-process architecture
 * uses IPC and does not implement or require these runtime entry points. */

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define BUNAWAY_HOST_ABI_VERSION 1u

typedef struct BunawayRuntimeHandle {
    uint64_t runtime_id;
    uint64_t generation;
} BunawayRuntimeHandle;

/* Issued and mapped by the native host; never serialize this into web JSON. */
typedef struct BunawayContextHandle {
    uint64_t runtime_id;
    uint64_t generation;
    uint64_t value;
} BunawayContextHandle;

typedef enum BunawayStatus {
    BUNAWAY_OK = 0,
    BUNAWAY_INVALID_ARGUMENT = 1,
    BUNAWAY_ABI_VERSION_MISMATCH = 2,
    BUNAWAY_QUEUE_FULL = 3,
    BUNAWAY_MESSAGE_TOO_LARGE = 4,
    BUNAWAY_STALE_HANDLE = 5,
    BUNAWAY_STOPPING = 6,
    BUNAWAY_BUSY = 7,
    BUNAWAY_INTERNAL_ERROR = 8
} BunawayStatus;

typedef enum BunawayRuntimeState {
    BUNAWAY_STATE_STARTING = 1,
    BUNAWAY_STATE_READY = 2,
    BUNAWAY_STATE_FAILED = 3,
    BUNAWAY_STATE_STOPPING = 4,
    BUNAWAY_STATE_STOPPED = 5
} BunawayRuntimeState;

typedef enum BunawayPostKind {
    /* The JSON envelope, including its IPC request ID, is carried unchanged. */
    BUNAWAY_POST_WEB_IPC = 1,
    /* Completes a pending Host API request identified out of band below. */
    BUNAWAY_POST_HOST_RESPONSE = 2
} BunawayPostKind;

typedef struct BunawayBytes {
    const uint8_t *data;
    size_t size;
} BunawayBytes;

/* Callback JSON and operation bytes are borrowed until return; there is no free call. */
typedef BunawayStatus (*BunawayOnWebMessage)(
    void *user_data,
    BunawayRuntimeHandle runtime,
    BunawayContextHandle context,
    BunawayBytes json
);

typedef BunawayStatus (*BunawayOnHostRequest)(
    void *user_data,
    BunawayRuntimeHandle runtime,
    BunawayContextHandle context,
    uint64_t request_id,
    const char *operation_utf8,
    size_t operation_size,
    BunawayBytes arguments_json
);

typedef void (*BunawayOnState)(
    void *user_data,
    BunawayRuntimeHandle runtime,
    BunawayRuntimeState state,
    BunawayStatus reason
);

/* start copies these values; user_data lives until bunaway_release returns OK. */
typedef struct BunawayHostCallbacks {
    void *user_data;
    BunawayOnState on_state;
    BunawayOnWebMessage on_web_message;
    BunawayOnHostRequest on_host_request;
} BunawayHostCallbacks;

typedef struct BunawayStartOptions {
    uint32_t abi_version;
    uint32_t max_queued_messages;
    uint32_t max_payload_bytes;
    uint32_t max_inflight_web_requests;
    uint32_t max_inflight_host_requests;
    /* Nonzero host-issued value reserved for manifest backend permissions. */
    uint64_t backend_context_value;
    /* Trusted local entrypoint and build ID; bootstrap.schema.json. Copied. */
    BunawayBytes bootstrap_json;
    BunawayHostCallbacks callbacks;
} BunawayStartOptions;

/*
 * These entry points return after admission or rejection; they never wait for
 * the runtime thread or invoke a callback inline. A successful start is async.
 */
/* options is copied before return; user_data itself remains host-owned. */
BunawayStatus bunaway_start(
    const BunawayStartOptions *options,
    BunawayRuntimeHandle *out_runtime
);

/*
 * context is supplied out of band by the host. For WEB_IPC, request_id must be
 * zero and json is a complete UTF-8 JSON envelope carrying its IPC ID. For
 * HOST_RESPONSE, request_id is the nonzero pending Host API request ID and json
 * follows host-response.schema.json. Accepted bytes
 * are copied before return; rejected input pointers are never retained.
 */
BunawayStatus bunaway_post_message(
    BunawayRuntimeHandle runtime,
    BunawayPostKind kind,
    BunawayContextHandle context,
    uint64_t request_id,
    BunawayBytes json
);

/*
 * Revoke a host-owned context on navigation/closure. Admission cannot fail due
 * to a full data queue. New posts are rejected as soon as this call succeeds;
 * runtime cleanup is asynchronous. Repeated revocation is harmless.
 */
BunawayStatus bunaway_revoke_context(
    BunawayRuntimeHandle runtime,
    BunawayContextHandle context
);

/* Idempotent after the first accepted stop request; completion is asynchronous. */
BunawayStatus bunaway_request_stop(BunawayRuntimeHandle runtime);

/*
 * Nonblocking quiescence check and adapter cleanup. BUSY until STOPPED has
 * returned and all callback activity has ended. On OK, user_data may be freed.
 * This does not promise Bun VM destruction or in-process restart support.
 */
BunawayStatus bunaway_release(BunawayRuntimeHandle runtime);

#ifdef __cplusplus
} /* extern "C" */
#endif

#endif /* BUNAWAY_HOST_API_H */
