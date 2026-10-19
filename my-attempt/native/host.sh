#!/bin/bash
exec "/usr/local/bin/node" "$(cd "$(dirname "$0")" && pwd)/host.js" "$@"
