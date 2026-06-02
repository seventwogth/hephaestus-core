package migrations

import "embed"

// Files keeps SQL migrations inside the binary so the generated app can migrate itself on startup.
//
//go:embed *.sql
var Files embed.FS
