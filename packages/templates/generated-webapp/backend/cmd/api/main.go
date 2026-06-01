package main

import (
	"log"
	"net/http"
	"os"

	apphttp "generated-webapp/backend/internal/http"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	router := apphttp.NewRouter()
	log.Printf("backend listening on :%s", port)
	if err := http.ListenAndServe(":"+port, router); err != nil {
		log.Fatal(err)
	}
}
