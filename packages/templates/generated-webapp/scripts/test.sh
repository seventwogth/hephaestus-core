#!/usr/bin/env sh
set -eu

(cd backend && go test ./...)
(cd frontend && npm test)
