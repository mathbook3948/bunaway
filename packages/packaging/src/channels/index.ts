// Built-in channel adapters register themselves via these side-effect
// imports. A new channel is a file under <platform>/ plus a registration in
// that platform's index — shared entry points stay untouched.
import "./windows/index.ts";
