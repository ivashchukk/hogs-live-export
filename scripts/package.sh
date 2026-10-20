#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
extension_dir="$project_dir/extension"
output_dir="$project_dir/dist"
archive="$output_dir/route-exporter.zip"

mkdir -p "$output_dir"
cd "$extension_dir"
zip -q -r -FS "$archive" . -x "*.DS_Store"

echo "$archive"
