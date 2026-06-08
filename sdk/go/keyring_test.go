package kolm

import (
	"bytes"
	"strings"
	"testing"
)

func TestDefaultKeyring(t *testing.T) {
	kr := DefaultKeyring()
	if len(kr) != 2 {
		t.Fatalf("len(DefaultKeyring()) = %d, want 2", len(kr))
	}
	byKID := map[string]Issuer{}
	for _, iss := range kr {
		byKID[iss.KID] = iss
	}

	prod, ok := byKID["kolm-prod-2026"]
	if !ok {
		t.Fatal("missing kolm-prod-2026 issuer")
	}
	if prod.Status != "production" {
		t.Errorf("prod.Status = %q, want production", prod.Status)
	}
	if prod.Fingerprint != "fa562154f99c95f48a45d04272943435" {
		t.Errorf("prod.Fingerprint = %q", prod.Fingerprint)
	}

	demo, ok := byKID["kolm-demo-2026"]
	if !ok {
		t.Fatal("missing kolm-demo-2026 issuer")
	}
	if demo.Status != "demo" {
		t.Errorf("demo.Status = %q, want demo", demo.Status)
	}

	// The keyring is self-consistent: the declared fingerprint of every issuer
	// equals the fingerprint independently derived from its public-key bytes.
	for _, iss := range kr {
		got, err := KeyFingerprintFromPEM(iss.PublicKey)
		if err != nil {
			t.Errorf("kid %s: %v", iss.KID, err)
			continue
		}
		if got != iss.Fingerprint {
			t.Errorf("kid %s: derived %q != declared %q", iss.KID, got, iss.Fingerprint)
		}
	}
}

func TestDefaultKeyringReturnsCopy(t *testing.T) {
	a := DefaultKeyring()
	a[0].KID = "mutated"
	b := DefaultKeyring()
	if b[0].KID == "mutated" {
		t.Error("DefaultKeyring() returns a shared slice; callers can corrupt it")
	}
}

func TestLoadKeyring(t *testing.T) {
	data := []byte(`{"schema":"kolm-issuer-keyring-1","issuers":[{"kid":"k","status":"demo","public_key":"PEM"}]}`)
	kr, err := LoadKeyring(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("LoadKeyring: %v", err)
	}
	if len(kr) != 1 || kr[0].KID != "k" {
		t.Errorf("got %+v", kr)
	}
}

func TestParseKeyringWrongSchema(t *testing.T) {
	if _, err := ParseKeyring([]byte(`{"schema":"nope","issuers":[]}`)); err == nil {
		t.Error("expected error for unexpected keyring schema")
	}
}

func TestMatchIssuer(t *testing.T) {
	kr := DefaultKeyring()

	iss, ok := MatchIssuer(demoPEM, kr)
	if !ok {
		t.Fatal("demo PEM should match the keyring")
	}
	if iss.KID != demoKID {
		t.Errorf("matched %q, want %q", iss.KID, demoKID)
	}

	// PEM comparison ignores whitespace differences (CRLF vs LF).
	noisy := strings.ReplaceAll(demoPEM, "\n", "\r\n")
	if _, ok := MatchIssuer(noisy, kr); !ok {
		t.Error("CRLF-normalized PEM should still match")
	}

	// An unknown key does not match.
	unknown := "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n-----END PUBLIC KEY-----\n"
	if _, ok := MatchIssuer(unknown, kr); ok {
		t.Error("unknown key unexpectedly matched")
	}
}
