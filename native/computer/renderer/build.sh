#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
output=${1:-"$source_dir/build"}
mkdir -p "$output/module-cache"
output=$(CDPATH= cd -- "$output" && pwd)
exec /usr/bin/swiftc -swift-version 6 -strict-concurrency=complete -warnings-as-errors \
  -O -module-cache-path "$output/module-cache" -framework AppKit \
  "$source_dir/Protocol.swift" "$source_dir/Transport.swift" \
  "$source_dir/EmergencyStop.swift" "$source_dir/Renderer.swift" "$source_dir/SelfTest.swift" "$source_dir/Main.swift" \
  -o "$output/computer-renderer"
