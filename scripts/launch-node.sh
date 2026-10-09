#!/bin/sh
# dsh-mac-cua: launch the Electron binary as Node. Avoids the `command: node`
# wrapper, which depends on $DSH_DESKTOP_NODE_EXECUTABLE that the mcp-client
# scrubs from the child env (all DSH_* names are dropped).
export ELECTRON_RUN_AS_NODE=1
exec "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" "$@"
