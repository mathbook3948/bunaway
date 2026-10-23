# Safe storage

Windows uses current-user DPAPI with `CRYPTPROTECT_UI_FORBIDDEN`. macOS uses a
Keychain-protected 32-byte random key and authenticated AES-256-GCM through Bun's
`node:crypto`. Neither provider falls back to plaintext. The app owns blob persistence.

The macOS adapter requires the trusted host's stable `app.id`. The default
traditional file-based Keychain stores a generic password with service
`org.bunaway.safe-storage.v1` and account `app.id`. Only encryption can add a
confirmed missing item. Reads, denial, cancellation, unavailable or malformed
keys never cause updates or deletion. Concurrent creators re-read the winner.
No key is cached across operations.

The blob layout is `BWSK` (4 bytes), version `1` (1 byte), a random 96-bit nonce,
ciphertext (0 to 256 KiB) and a 128-bit GCM tag. The header and UTF-8 app identity
are authenticated additional data. Unknown versions and lengths fail before
Keychain access. Authentication must complete before returning any plaintext.
The format is distinct from Windows DPAPI and has no cross-platform migration.

Explicit macOS encryption/decryption allows Apple's access/unlock interaction.
`isAvailable` only reads unlocked/readable/writable Keychain status without
provisioning or prompting; it does not test item ACL access. User cancellation
maps to `CANCELLED`, denied or unavailable interaction to `PERMISSION_DENIED`,
other provider/key/authentication failures to `INTERNAL`. Call cancellation
cannot interrupt a synchronous Security.framework call or dismiss its dialog.
The host revokes admission and drops late responses; normal adapter disposal
waits for synchronous execution to return. A host shutdown deadline may force
Worker termination and reports failure, rather than claiming successful cleanup.
Completed key creation cannot be rolled back by transport cancellation.

Keychain access belongs to the actual host executable. An appId is a namespace,
not an OS principal. Shared Bun development hosts provide no per-JS-app OS
isolation. Compiled apps use their own default executable ACL. Unsigned and
ad-hoc builds have no certificate-backed stable identity across rebuilds or
relocation; renewed approval or denial is possible. This adapter never changes
ACLs to bypass that limitation or invents signing entitlements or certificates.

We choose the traditional file-based Keychain rather than the entitlement-gated
data-protection Keychain for existing ad-hoc hosts. Apple deprecated traditional
APIs in macOS 12. This is a deliberate compatibility constraint, covered by native
CI, not a claim that ad-hoc signing grants data-protection access groups.
See [Apple TN3137](https://developer.apple.com/documentation/technotes/tn3137-on-mac-keychains)
and [Apple's implementation distinction](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/SecItem.cpp#L4883).

Tests use synthetic data and an explicitly selected disposable private Keychain
called `synthetic.keychain`, without changing the default, search list or trust.
[Apple's private-Keychain search-list rule](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_keychain/lib/StorageManager.cpp#L119)
supports that isolation. Native tests cover both shared Bun and an existing
ad-hoc signing flow, plus restart with the same executable. System UI decisions,
login Keychain, distribution-certificate upgrades and real credentials are not
exercised. Windows contracts and tests remain unchanged.

The macOS host dispatch uses the revised shutdown-cancellation foundation in
PR164. This feature separately propagates the verified package's host-owned app
identity into the I/O Worker. `tests/lifecycle/macos-safe-storage-host.ts` drives
the public backend and WKWebView API in shared Bun and ad-hoc compiled hosts,
with per-operation policy, caller identity rejection, encrypted restart and
Core-before-native cleanup. Only the internal Keychain provider is replaced to
select each disposable fixture; production schemas, adapter, crypto, host, SDK
and actual WKWebView remain in use. Native CI results must be checked for the
exact head; successful static bundling does not prove native execution.

## Windows credential store

`setSecret`, `getSecret` and `deleteSecret` keep a user secret in Windows Credential Manager
(`CredWriteW`, `CredReadW`, `CredDeleteW`) as a `CRED_TYPE_GENERIC` entry with
`CRED_PERSIST_LOCAL_MACHINE`. The plugin builds the target `bunaway.safe-storage:<app.id>:<key>`;
keys are 1 to 128 characters of `a-z0-9._-` (lowercase, because target names are case-insensitive), so the last colon separates app id from key.
Values are non-empty UTF-16LE text up to `CRED_MAX_CREDENTIAL_BLOB_SIZE` (2,560 bytes). A missing key
reads as `null` and deletes as `false`. The implementation zeroes the native blob and every copy and releases it with
`CredFree`; no test checks that cleanup. The namespace is not an OS principal: other processes of the same user can read the entry.
Without a host `app.id` these operations fail with `INVALID_ARGUMENT`.
`tests/lifecycle/windows-safe-storage.test.ts` exercises the real store on Windows CI.

## macOS credential store

The same three operations keep a user secret in the default file-based Keychain as a generic
password with service `org.bunaway.safe-storage.secret.v1` and account `<app.id>:<key>`, separate from
the protection key item, which they never create or read. Keys and values follow the Windows rules; values are
stored as UTF-8. Setting an existing key modifies the item in place, so a failed replacement keeps the
previous value. Access follows the executable identity rules above: the creating executable reads its items
without a prompt and a different executable needs Keychain approval. The native copy and every intermediate buffer are
zeroed before release. `tests/lifecycle/macos-keychain-native.test.ts` runs the real Security.framework against a
disposable private Keychain and `tests/lifecycle/macos-safe-storage-host.ts` covers the public API across a restart.
