// Flight fixture app (Go): a dependency-free notes API.
//
// The non-web-stack twin of first-flight-app (Node). Contracts the flight
// exercises on a repo with no package.json, no npm scripts, no lockfile:
//   - Reads PORT from the environment (native port injection — portify's
//     zero-edit fast path), falling back to the -port flag.
//   - Refuses to boot without AUTH_TOKEN (exercises env capture; the value
//     ships in the sibling .env file, which this app loads itself).
//   - GET /health is the readiness probe.
//   - DELIBERATE BUG for the heal loop: POST /notes acknowledges the note but
//     never appends it, so GET /notes stays empty. A correct E2E spec on the
//     create→list path fails until the heal agent adds the missing append.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
)

type note struct {
	ID    int    `json:"id"`
	Title string `json:"title"`
}

var (
	mu    sync.Mutex
	notes = []note{}
	nextID = 1
)

// loadDotEnv fills os environment values from the sibling .env file (no
// external deps — the fixture must stay install-free).
func loadDotEnv() {
	raw, err := os.ReadFile(".env")
	if err != nil {
		return
	}
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		eq := strings.Index(trimmed, "=")
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(trimmed[:eq])
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, strings.TrimSpace(trimmed[eq+1:]))
		}
	}
}

func main() {
	portFlag := flag.String("port", "", "port to listen on (defaults to $PORT)")
	flag.Parse()

	loadDotEnv()
	if os.Getenv("AUTH_TOKEN") == "" {
		fmt.Fprintln(os.Stderr, "AUTH_TOKEN is required (set it in .env) — refusing to start.")
		os.Exit(1)
	}

	port := os.Getenv("PORT")
	if *portFlag != "" {
		port = *portFlag
	}
	if port == "" {
		port = "8090"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		fmt.Fprint(w, `{"ok":true}`)
	})
	mux.HandleFunc("POST /notes", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Title string `json:"title"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil || strings.TrimSpace(body.Title) == "" {
			w.Header().Set("content-type", "application/json")
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":"title is required"}`)
			return
		}
		mu.Lock()
		created := note{ID: nextID, Title: strings.TrimSpace(body.Title)}
		nextID++
		// BUG (deliberate, for the heal loop): the created note is never
		// appended to `notes`, so GET /notes stays empty.
		mu.Unlock()
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(created)
	})
	mux.HandleFunc("GET /notes", func(w http.ResponseWriter, _ *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(notes)
	})

	fmt.Printf("first-flight-go listening on :%s\n", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
