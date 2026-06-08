package kolm

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// Issuer is one trusted kolm signing identity. A report is "issuer-recognized"
// (Tier 2) when its embedded public_key matches the PublicKey of an Issuer in the
// keyring. Fields mirror public/keys/kolm-issuers.json.
type Issuer struct {
	// KID is the stable key id, e.g. "kolm-prod-2026".
	KID string `json:"kid"`
	// Label is a human-readable name for the issuer.
	Label string `json:"label"`
	// Status is "production" or "demo". A demo key is recognized as a kolm demo,
	// never as production-issued evidence — inspect this before relying on a
	// Trusted() verdict for a compliance decision.
	Status string `json:"status"`
	// Alg is the signature algorithm, always "ed25519".
	Alg string `json:"alg"`
	// PublicKey is the SPKI PEM the issuer signs with.
	PublicKey string `json:"public_key"`
	// Fingerprint is the first 32 hex chars of SHA-256 over the SPKI DER.
	Fingerprint string `json:"fingerprint"`
	// Note is an advisory description of the issuer's role.
	Note string `json:"note"`
}

// keyringFile is the on-disk shape of kolm-issuers.json.
type keyringFile struct {
	Schema    string   `json:"schema"`
	UpdatedAt string   `json:"updated_at"`
	Issuers   []Issuer `json:"issuers"`
}

// KeyringSchema is the schema marker of a kolm issuer keyring file.
const KeyringSchema = "kolm-issuer-keyring-1"

//go:embed keyring/kolm-issuers.json
var embeddedKeyring []byte

var (
	defaultKeyringOnce sync.Once
	defaultKeyring     []Issuer
	defaultKeyringErr  error
)

// DefaultKeyring returns the kolm issuers published at build time (an embedded
// copy of public/keys/kolm-issuers.json), so offline verification needs no
// network and no files on disk. The returned slice is a fresh copy on every call;
// mutating it does not affect future calls.
//
// To verify against the live keyring instead — for example to pick up a freshly
// rotated production key before this SDK is rebuilt — fetch the public key from
// GET /v1/audit/issuer-key (see [Client.IssuerKey]) and build your own []Issuer,
// or load an updated kolm-issuers.json with [LoadKeyring].
func DefaultKeyring() []Issuer {
	defaultKeyringOnce.Do(func() {
		defaultKeyring, defaultKeyringErr = ParseKeyring(embeddedKeyring)
	})
	if defaultKeyringErr != nil {
		// The embedded file is committed alongside this code and parsed in tests,
		// so this is effectively unreachable; panic rather than silently return a
		// keyring that would make every report "issuer-unrecognized".
		panic("kolm: embedded keyring is invalid: " + defaultKeyringErr.Error())
	}
	out := make([]Issuer, len(defaultKeyring))
	copy(out, defaultKeyring)
	return out
}

// ParseKeyring parses kolm-issuers.json bytes into a slice of issuers.
func ParseKeyring(data []byte) ([]Issuer, error) {
	var kf keyringFile
	if err := json.Unmarshal(data, &kf); err != nil {
		return nil, fmt.Errorf("kolm: invalid keyring JSON: %w", err)
	}
	if kf.Schema != "" && kf.Schema != KeyringSchema {
		return nil, fmt.Errorf("kolm: unexpected keyring schema %q (want %q)", kf.Schema, KeyringSchema)
	}
	return kf.Issuers, nil
}

// LoadKeyring reads and parses a kolm-issuers.json document from r.
func LoadKeyring(r io.Reader) ([]Issuer, error) {
	data, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("kolm: cannot read keyring: %w", err)
	}
	return ParseKeyring(data)
}
