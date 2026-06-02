package main

import (
	"context"
	"log"
	"net/http"
	"os"

	apphttp "generated-webapp/backend/internal/http"
	"generated-webapp/backend/internal/platform/database"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL is required")
	}

	ctx := context.Background()
	db, err := database.Open(ctx, databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	if err := database.Migrate(ctx, db); err != nil {
		log.Fatal(err)
	}

	router := apphttp.NewRouter(apphttp.NewGeneratedRouteRegistrar(db))
	log.Printf("backend listening on :%s", port)
	if err := http.ListenAndServe(":"+port, router); err != nil {
		log.Fatal(err)
	}
}
