package http

import "database/sql"

func NewGeneratedRouteRegistrar(_ *sql.DB) GeneratedRouteRegistrar {
	return noopGeneratedRouteRegistrar{}
}
