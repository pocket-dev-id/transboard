package network

import (
	"crypto/subtle"
	"net/http"
)

type TokenProvider func() string

func Authorized(r *http.Request, provider TokenProvider) bool {
	if provider == nil {
		return false
	}
	expected := provider()
	actual := r.Header.Get("X-API-Token")
	if expected == "" || actual == "" || len(expected) != len(actual) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(expected), []byte(actual)) == 1
}
