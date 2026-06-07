#!/usr/bin/env sh
set -eu

before="$(mktemp)"
after="$(mktemp)"
trap 'rm -f "$before" "$after"' EXIT

git diff -- package.json package-lock.json apps/*/package.json packages/*/package.json > "$before"
npm install --package-lock-only --ignore-scripts
git diff -- package.json package-lock.json apps/*/package.json packages/*/package.json > "$after"

diff -u "$before" "$after"
